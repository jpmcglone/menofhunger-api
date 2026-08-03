import { BadRequestException, ForbiddenException, Injectable, Logger, NotFoundException } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { PresenceRealtimeService } from '../presence/presence-realtime.service';
import { SideEffectsService } from '../side-effects/side-effects.service';
import { CacheInvalidationService } from '../redis/cache-invalidation.service';
import { AppConfigService } from '../app/app-config.service';
import { PostViewsService } from '../post-views/post-views.service';
import { PosthogService } from '../../common/posthog/posthog.service';
import { MENTION_USER_SELECT, USER_LIST_SELECT } from '../../common/prisma-selects/user.select';
import { toPostDto } from '../../common/dto/post.dto';
import { PostsRankingService } from './posts-ranking.service';
import { PostsFeedQueryService } from './posts-feed-query.service';

/**
 * Post engagement mutations: boosts and flat reposts (poll voting lives in
 * PollsService). Owns the notification + realtime + score-refresh fan-out for
 * each engagement action. Uses PostsFeedQueryService for access-checked
 * single-post reads.
 */
@Injectable()
export class PostsEngagementService {
  private readonly logger = new Logger(PostsEngagementService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly sideEffects: SideEffectsService,
    private readonly presenceRealtime: PresenceRealtimeService,
    private readonly cacheInvalidation: CacheInvalidationService,
    private readonly appConfig: AppConfigService,
    private readonly postViews: PostViewsService,
    private readonly posthog: PosthogService,
    private readonly ranking: PostsRankingService,
    private readonly feedQuery: PostsFeedQueryService,
  ) {}

  private async ensureUserCanBoost(userId: string) {
    const user = await this.prisma.user.findUnique({
      where: { id: userId },
      select: { id: true, usernameIsSet: true, verifiedStatus: true },
    });
    if (!user) throw new NotFoundException('User not found.');
    if (!user.usernameIsSet) throw new ForbiddenException('Set a username to boost posts.');
    // Unverified users may boost public posts (their boost counts less in ranking via
    // the tier-weighted boostScore). Visibility scope is enforced by the caller.
    return user;
  }

  async boostPost(params: { userId: string; postId: string }) {
    const { userId, postId } = params;
    const id = (postId ?? '').trim();
    if (!id) throw new NotFoundException('Post not found.');

    const booster = await this.ensureUserCanBoost(userId);

    const post = await this.feedQuery.getById({ viewerUserId: userId, id });
    if (post.deletedAt) throw new BadRequestException('Deleted posts cannot be boosted.');
    if (post.visibility === 'onlyMe') throw new BadRequestException('Only-me posts cannot be boosted.');

    // Unverified users may only boost public posts (defense-in-depth; getById already
    // blocks unverified viewers from verified-only / premium-only posts).
    const boosterIsVerified = Boolean(booster.verifiedStatus && booster.verifiedStatus !== 'none');
    if (!boosterIsVerified && post.visibility !== 'public') {
      throw new ForbiddenException('Verify to boost verified-only posts.');
    }

    // Block check: neither direction may boost across a block.
    if (post.user?.id && post.user.id !== userId) {
      const blockCount = await this.prisma.userBlock.count({
        where: {
          OR: [
            { blockerId: userId, blockedId: post.user.id },
            { blockerId: post.user.id, blockedId: userId },
          ],
        },
      });
      if (blockCount > 0) throw new ForbiddenException('You cannot boost this post.');
    }

    const res = await this.prisma.$transaction(async (tx) => {
      const created = await tx.boost.createMany({
        data: [{ postId: id, userId }],
        skipDuplicates: true,
      });

      if (created.count === 1) {
        await tx.post.update({
          where: { id },
          data: {
            boostCount: { increment: 1 },
            boostScore: null,
            boostScoreUpdatedAt: null,
          },
        });
      }

      const updated = await tx.post.findUnique({
        where: { id },
        select: { boostCount: true },
      });

      return {
        boostCount: updated?.boostCount ?? 0,
        createdCount: created.count,
      };
    });

    if (post.userId !== userId) {
      this.sideEffects.dispatch('post.engagement.changed', {
        kind: 'boost',
        active: true,
        postId: id,
        recipientUserId: post.userId,
        actorUserId: userId,
      });
    }

    // Boosting implies the user saw the post.
    void this.postViews.markViewed(userId, id);

    // Realtime post interaction update (post author + actor) — used by the
    // actor to flip viewerHasBoosted, and by the author for engagement UX.
    const recipients = new Set<string>([userId, post.userId].filter(Boolean));
    this.presenceRealtime.emitPostsInteraction(recipients, {
      postId: id,
      actorUserId: userId,
      kind: 'boost',
      active: true,
      boostCount: res.boostCount,
    });

    // Realtime fan-out to the post room so every viewer of this post (not just
    // the author) sees the new boost count update live.
    try {
      this.presenceRealtime.emitPostsLiveUpdated(id, {
        postId: id,
        version: new Date().toISOString(),
        reason: 'boost_changed',
        patch: { boostCount: res.boostCount },
      });
    } catch {
      // Best-effort
    }

    // Popular/trending/featured feeds are boost-sensitive. Bump so anon caches shift instantly.
    await this.cacheInvalidation.bumpFeedGlobal();
    this.ranking.enqueueScoreRefresh(id);

    if (res.createdCount === 1) {
      this.posthog.capture(userId, 'boost_tapped', { post_id: id });
    }

    return { success: true, viewerHasBoosted: true, boostCount: res.boostCount };
  }

  async unboostPost(params: { userId: string; postId: string }) {
    const { userId, postId } = params;
    const id = (postId ?? '').trim();
    if (!id) throw new NotFoundException('Post not found.');

    await this.ensureUserCanBoost(userId);

    const post = await this.feedQuery.getById({ viewerUserId: userId, id });
    if (post.deletedAt) throw new BadRequestException('Deleted posts cannot be boosted.');
    if (post.visibility === 'onlyMe') throw new BadRequestException('Only-me posts cannot be boosted.');

    const res = await this.prisma.$transaction(async (tx) => {
      const deleted = await tx.boost.deleteMany({
        where: { postId: id, userId },
      });

      if (deleted.count === 1) {
        await tx.post.update({
          where: { id },
          data: {
            boostCount: { decrement: 1 },
            boostScore: null,
            boostScoreUpdatedAt: null,
          },
        });
      }

      const updated = await tx.post.findUnique({
        where: { id },
        select: { boostCount: true },
      });

      return {
        boostCount: updated?.boostCount ?? 0,
      };
    });

    if (post.userId !== userId) {
      this.sideEffects.dispatch('post.engagement.changed', {
        kind: 'boost',
        active: false,
        postId: id,
        recipientUserId: post.userId,
        actorUserId: userId,
      });
    }

    // Realtime post interaction update (post author + actor) — used by the
    // actor to flip viewerHasBoosted, and by the author for engagement UX.
    const recipients = new Set<string>([userId, post.userId].filter(Boolean));
    this.presenceRealtime.emitPostsInteraction(recipients, {
      postId: id,
      actorUserId: userId,
      kind: 'boost',
      active: false,
      boostCount: res.boostCount,
    });

    // Realtime fan-out to the post room so every viewer of this post (not just
    // the author) sees the new boost count update live.
    try {
      this.presenceRealtime.emitPostsLiveUpdated(id, {
        postId: id,
        version: new Date().toISOString(),
        reason: 'boost_changed',
        patch: { boostCount: res.boostCount },
      });
    } catch {
      // Best-effort
    }

    // Popular/trending/featured feeds are boost-sensitive. Bump so anon caches shift instantly.
    await this.cacheInvalidation.bumpFeedGlobal();
    this.ranking.enqueueScoreRefresh(id);

    return { success: true, viewerHasBoosted: false, boostCount: res.boostCount };
  }

  async repostPost(params: { userId: string; postId: string }) {
    const { userId, postId } = params;
    const id = (postId ?? '').trim();
    if (!id) throw new NotFoundException('Post not found.');

    const user = await this.prisma.user.findUnique({
      where: { id: userId },
      select: { id: true, usernameIsSet: true, verifiedStatus: true },
    });
    if (!user) throw new NotFoundException('User not found.');
    if (!user.usernameIsSet) throw new ForbiddenException('Set a username to repost.');
    if (!user.verifiedStatus || user.verifiedStatus === 'none') {
      throw new ForbiddenException('Verify your account to repost.');
    }

    // Resolve the canonical original post (flatten repost-of-repost).
    const targetPost = await this.prisma.post.findFirst({
      where: { id, deletedAt: null },
      select: { id: true, userId: true, visibility: true, kind: true, repostedPostId: true, communityGroupId: true },
    });
    if (!targetPost) throw new NotFoundException('Post not found.');
    if (targetPost.visibility === 'onlyMe') throw new BadRequestException('Only-me posts cannot be reposted.');

    // Flatten: if target is itself a flat repost, point to its original.
    let canonicalId: string = id;
    if (targetPost.kind === 'repost' && targetPost.repostedPostId) {
      const canonical = await this.prisma.post.findFirst({
        where: { id: targetPost.repostedPostId, deletedAt: null },
        select: { id: true, userId: true, visibility: true, communityGroupId: true },
      });
      if (!canonical) throw new NotFoundException('Post not found.');
      canonicalId = canonical.id;
    }

    // Block check.
    const canonicalPost = canonicalId === id ? targetPost : await this.prisma.post.findFirst({ where: { id: canonicalId }, select: { id: true, userId: true, visibility: true, communityGroupId: true } });
    if (!canonicalPost) throw new NotFoundException('Post not found.');

    // Scope preservation: a repost must live in the same place as the post it reshares.
    // If the canonical post belongs to a community group, the repost stays in that group
    // (never leaks to global feeds) AND requires the actor to be an active member — you
    // can only repost into a group you're allowed to post in.
    const canonicalGroupId = (canonicalPost as { communityGroupId?: string | null }).communityGroupId ?? null;
    if (canonicalGroupId) {
      const membership = await this.prisma.communityGroupMember.findUnique({
        where: { groupId_userId: { groupId: canonicalGroupId, userId } },
        select: { status: true },
      });
      if (!membership || membership.status !== 'active') {
        throw new ForbiddenException('Join this group to repost here.');
      }
    }

    if (canonicalPost.userId && canonicalPost.userId !== userId) {
      const blockCount = await this.prisma.userBlock.count({
        where: {
          OR: [
            { blockerId: userId, blockedId: canonicalPost.userId },
            { blockerId: canonicalPost.userId, blockedId: userId },
          ],
        },
      });
      if (blockCount > 0) throw new ForbiddenException('You cannot repost this post.');
    }

    // Attempt to create the flat repost and increment the count atomically.
    // The partial unique index on (userId, repostedPostId) WHERE kind='repost' AND deletedAt IS NULL
    // enforces one live repost per user per canonical post. A concurrent duplicate hits P2002 and
    // is treated as an idempotent return, closing the check-then-insert race window.
    let repostCount: number;
    let repostId: string;
    try {
      const txResult = await this.prisma.$transaction(async (tx) => {
        const repost = await tx.post.create({
          data: {
            body: '',
            userId,
            kind: 'repost',
            visibility: canonicalPost.visibility,
            repostedPostId: canonicalId,
            communityGroupId: canonicalGroupId,
            topics: [],
            hashtags: [],
            hashtagCasings: [],
          },
          select: { id: true },
        });
        const updated = await tx.post.update({
          where: { id: canonicalId },
          data: { repostCount: { increment: 1 } },
          select: { repostCount: true },
        });
        return { repostId: repost.id as string, repostCount: updated.repostCount as number };
      });
      repostId = txResult.repostId;
      repostCount = txResult.repostCount;
    } catch (e: unknown) {
      if (
        e instanceof Prisma.PrismaClientKnownRequestError &&
        e.code === 'P2002'
      ) {
        // Unique constraint violation: another concurrent request already created the repost.
        // Return the existing repost row idempotently.
        this.logger.debug(`repostPost: P2002 race on (userId=${userId}, canonicalId=${canonicalId}), returning existing repost`);
        const existing = await this.prisma.post.findFirst({
          where: { userId, kind: 'repost', repostedPostId: canonicalId, deletedAt: null },
          select: { id: true },
        });
        const countRow = await this.prisma.post.findUnique({ where: { id: canonicalId }, select: { repostCount: true } });
        return { reposted: true as const, repostId: existing?.id ?? '', repostCount: countRow?.repostCount ?? 0 };
      }
      throw e;
    }

    // Notify original author (not self-repost).
    if (canonicalPost.userId !== userId) {
      this.sideEffects.dispatch('post.engagement.changed', {
        kind: 'repost',
        active: true,
        postId: canonicalId,
        recipientUserId: canonicalPost.userId,
        actorUserId: userId,
        actorPostId: repostId,
      });
    }

    // Realtime fan-out: every viewer subscribed to the canonical post's room
    // gets the updated repostCount in real time (best-effort).
    try {
      this.presenceRealtime.emitPostsLiveUpdated(canonicalId, {
        postId: canonicalId,
        version: new Date().toISOString(),
        reason: 'repost_changed',
        patch: { repostCount },
      });
    } catch {
      // Best-effort
    }

    // Per-user interaction event: flips viewerHasReposted for the actor, and lets the
    // canonical post's author see the updated repostCount in their engagement view.
    const interactionRecipients = new Set<string>(
      [userId, canonicalPost.userId].filter(Boolean) as string[],
    );
    this.presenceRealtime.emitPostsInteraction(interactionRecipients, {
      postId: canonicalId,
      actorUserId: userId,
      kind: 'repost',
      active: true,
      repostCount,
    });

    // Fan-out: emit the new repost post to the home feed of each follower of the reposter,
    // so they see it live without refreshing. Fire-and-forget — same pattern as post.created.
    void this.emitFeedRepostToFollowers(repostId, userId);

    // Realtime: a group repost is a new item in the group feed. Push the full repost DTO
    // (with its embedded original) to the `group:{id}` room so members viewing the group
    // see it live. Fire-and-forget: building the DTO needs two reads, so we keep it off
    // the response path.
    if (canonicalGroupId) {
      void this.emitGroupRepostCreated(canonicalGroupId, repostId, canonicalId);
    }

    void this.postViews.markViewed(userId, canonicalId);
    await this.cacheInvalidation.bumpFeedGlobal();
    this.ranking.enqueueScoreRefresh(canonicalId);
    this.ranking.enqueueScoreRefresh(repostId);

    return { reposted: true as const, repostId, repostCount };
  }

  /**
   * Best-effort: assemble the full DTO for a freshly created group repost (including its
   * embedded original post) and emit it to the group feed room. Swallows all errors — a
   * missed live emit just means the post shows up on the next group-feed fetch.
   */
  private async emitGroupRepostCreated(groupId: string, repostId: string, canonicalId: string): Promise<void> {
    try {
      const include = {
        user: { select: USER_LIST_SELECT },
        media: { orderBy: { position: 'asc' as const } },
        mentions: { include: { user: { select: MENTION_USER_SELECT } } },
        poll: { include: { options: { orderBy: { position: 'asc' as const } } } },
      };
      const [repostRow, canonicalRow] = await Promise.all([
        this.prisma.post.findFirst({ where: { id: repostId, deletedAt: null }, include }),
        this.prisma.post.findFirst({ where: { id: canonicalId, deletedAt: null }, include }),
      ]);
      if (!repostRow || !canonicalRow) return;

      const baseUrl = this.appConfig.r2()?.publicBaseUrl ?? null;
      const repostedPostDto = toPostDto(canonicalRow as any, baseUrl, {
        viewerHasBoosted: false,
        includeInternal: false,
      });
      const repostDto = toPostDto(repostRow as any, baseUrl, {
        viewerHasBoosted: false,
        includeInternal: false,
        repostedPost: repostedPostDto,
      });
      const repostVisibility = (repostRow as any).visibility ?? 'public';
      if (repostVisibility === 'public') {
        this.presenceRealtime.emitGroupNewPost(groupId, { groupId, post: repostDto });
      } else {
        const eligibleMembers = await this.prisma.communityGroupMember.findMany({
          where: { groupId, status: 'active' },
          select: { userId: true, user: { select: { premium: true, premiumPlus: true, verifiedStatus: true } } },
        });
        const eligible = eligibleMembers
          .filter((m) => {
            if (repostVisibility === 'premiumOnly') return m.user.premium || m.user.premiumPlus;
            return (m.user.verifiedStatus && m.user.verifiedStatus !== 'none') || m.user.premium || m.user.premiumPlus;
          })
          .map((m) => m.userId);
        if (eligible.length > 0) {
          this.presenceRealtime.emitGroupNewPost(groupId, { groupId, post: repostDto }, { eligibleMemberUserIds: eligible });
        }
      }
    } catch {
      // Best-effort
    }
  }

  async unrepostPost(params: { userId: string; postId: string }) {
    const { userId, postId } = params;
    const id = (postId ?? '').trim();
    if (!id) throw new NotFoundException('Post not found.');

    // Resolve canonical post (works whether caller passes repostId or original postId).
    const targetPost = await this.prisma.post.findFirst({
      where: { id, deletedAt: null },
      select: { id: true, userId: true, kind: true, repostedPostId: true },
    });
    if (!targetPost) throw new NotFoundException('Post not found.');

    // Determine canonical ID.
    const canonicalId = targetPost.kind === 'repost' && targetPost.repostedPostId
      ? targetPost.repostedPostId
      : id;

    // Find the viewer's flat repost of the canonical post.
    const existingRepost = await this.prisma.post.findFirst({
      where: { userId, kind: 'repost', repostedPostId: canonicalId, deletedAt: null },
      select: { id: true },
    });
    if (!existingRepost) {
      const updated = await this.prisma.post.findUnique({ where: { id: canonicalId }, select: { repostCount: true } });
      return { reposted: false as const, repostCount: updated?.repostCount ?? 0 };
    }

    const { repostCount } = await this.prisma.$transaction(async (tx) => {
      await tx.post.delete({ where: { id: existingRepost.id } });
      const updated = await tx.post.update({
        where: { id: canonicalId },
        data: { repostCount: { decrement: 1 } },
        select: { repostCount: true },
      });
      return { repostCount: updated.repostCount as number };
    });

    // Clean up repost notification.
    const canonicalPost = await this.prisma.post.findFirst({ where: { id: canonicalId }, select: { userId: true } });
    if (canonicalPost?.userId && canonicalPost.userId !== userId) {
      this.sideEffects.dispatch('post.engagement.changed', {
        kind: 'repost',
        active: false,
        postId: canonicalId,
        recipientUserId: canonicalPost.userId,
        actorUserId: userId,
      });
    }

    // Realtime fan-out: every viewer subscribed to the canonical post's room
    // gets the updated repostCount in real time (best-effort).
    try {
      this.presenceRealtime.emitPostsLiveUpdated(canonicalId, {
        postId: canonicalId,
        version: new Date().toISOString(),
        reason: 'repost_changed',
        patch: { repostCount },
      });
    } catch {
      // Best-effort
    }

    // Per-user interaction event: flips viewerHasReposted=false for the actor.
    const unrepostRecipients = new Set<string>(
      [userId, canonicalPost?.userId].filter(Boolean) as string[],
    );
    this.presenceRealtime.emitPostsInteraction(unrepostRecipients, {
      postId: canonicalId,
      actorUserId: userId,
      kind: 'repost',
      active: false,
      repostCount,
    });

    await this.cacheInvalidation.bumpFeedGlobal();
    this.ranking.enqueueScoreRefresh(canonicalId);
    return { reposted: false as const, repostCount };
  }

  /**
   * Best-effort: push the newly created repost shell to the home feeds of the reposter's
   * followers so they see it live without refreshing. Mirrors the `emitFeedNewPost` call
   * in the post.created side-effects handler.
   *
   * Swallows all errors — a missed live emit just means the row shows up on the next feed
   * refresh. The repost shell ID and reposter user ID are sufficient to read the full data.
   */
  private async emitFeedRepostToFollowers(repostId: string, reposterId: string): Promise<void> {
    try {
      const include = {
        user: { select: USER_LIST_SELECT },
        media: { orderBy: { position: 'asc' as const } },
        mentions: { include: { user: { select: MENTION_USER_SELECT } } },
        poll: { include: { options: { orderBy: { position: 'asc' as const } } } },
      };
      const [repostRow, followRows] = await Promise.all([
        this.prisma.post.findFirst({
          where: { id: repostId, deletedAt: null },
          include: {
            ...include,
            // Also load the original post so we can embed it in the DTO.
            repostedPost: { include },
          },
        }),
        this.prisma.follow.findMany({
          where: { followingId: reposterId },
          select: { followerId: true },
          take: 500,
        }),
      ]);
      if (!repostRow || followRows.length === 0) return;

      const baseUrl = this.appConfig.r2()?.publicBaseUrl ?? null;
      const repostedOriginal = (repostRow as any).repostedPost;
      const repostedPostDto = repostedOriginal
        ? toPostDto(repostedOriginal, baseUrl, { viewerHasBoosted: false, includeInternal: false })
        : undefined;
      const repostDto = toPostDto(repostRow as any, baseUrl, {
        viewerHasBoosted: false,
        includeInternal: false,
        repostedPost: repostedPostDto,
      });

      const followerIds = followRows.map((f) => f.followerId);
      this.presenceRealtime.emitFeedNewPost(followerIds, { post: repostDto });
    } catch {
      // Best-effort
    }
  }
}
