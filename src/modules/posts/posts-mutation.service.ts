import { BadRequestException, ForbiddenException, HttpException, HttpStatus, Injectable, Logger, NotFoundException } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import type { PostVisibility, CommunityGroupJoinPolicy } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { NotificationsService } from '../notifications/notifications.service';
import { PresenceRealtimeService } from '../presence/presence-realtime.service';
import { ViewerContextService } from '../viewer/viewer-context.service';
import { AppConfigService } from '../app/app-config.service';
import { CacheInvalidationService } from '../redis/cache-invalidation.service';
import { MENTION_USER_SELECT, USER_LIST_SELECT } from '../../common/prisma-selects/user.select';
import { parseMentionsFromBody as parseMentionsFromBodyText } from '../../common/mentions/mention-regex';
import { parseHashtagTokensFromText, type HashtagToken } from '../../common/hashtags/hashtag-regex';
import { parseCashtagCandidatesFromText } from '../../common/cashtags/cashtag-regex';
import { TickerService } from '../cashtags/ticker.service';
import { inferTopicsFromText } from '../../common/topics/topic-utils';
import { easternDayKey, yesterdayEasternDayKey } from '../../common/time/eastern-day-key';
import { computeCheckinRewards } from '../checkins/checkin-rewards';
import { computeCheckinStreakStats } from '../checkins/checkin-streaks';
import { toUserDto } from '../../common/dto/user.dto';
import { toPostDto } from '../../common/dto/post.dto';
import { publicAssetUrl } from '../../common/assets/public-asset-url';
import { LOGGED_IN_VIEW_WEIGHT } from '../views/view-tracking.utils';
import { PostViewsService } from '../post-views/post-views.service';
import { JobsService } from '../jobs/jobs.service';
import { JOBS } from '../jobs/jobs.constants';
import { PosthogService } from '../../common/posthog/posthog.service';
import { MarvinBotIdentityService } from '../marvin/services/marvin-bot-identity.service';
import { notDeletedWhere } from './posts-query-builders';
import {
  resolveMentionUsernames as resolveMentionUsernamesQuery,
  resolveMentionUsernamesMap as resolveMentionUsernamesMapQuery,
} from './posts-mentions.helpers';
import { PostsRankingService } from './posts-ranking.service';
import { PostsViewerEnrichmentService } from './posts-viewer-enrichment.service';

/**
 * Post write paths: create (with the full side-effect pipeline), update,
 * delete, publish-from-onlyMe, and the site-config rate-limit cache. Reads
 * stay in PostsFeedQueryService; engagement mutations (boost/repost) live in
 * PostsEngagementService.
 */
@Injectable()
export class PostsMutationService {
  private readonly logger = new Logger(PostsMutationService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly notifications: NotificationsService,
    private readonly presenceRealtime: PresenceRealtimeService,
    private readonly cacheInvalidation: CacheInvalidationService,
    private readonly appConfig: AppConfigService,
    private readonly postViews: PostViewsService,
    private readonly jobs: JobsService,
    private readonly posthog: PosthogService,
    private readonly marvIdentity: MarvinBotIdentityService,
    private readonly viewerContextService: ViewerContextService,
    private readonly enrichment: PostsViewerEnrichmentService,
    private readonly ranking: PostsRankingService,
    private readonly ticker: TickerService,
  ) {}

  private async recomputeStreakFromPostsTx(tx: Prisma.TransactionClient, userId: string, now: Date): Promise<void> {
    const posts = await tx.post.findMany({
      where: { userId, visibility: { not: 'onlyMe' }, deletedAt: null, isDraft: false },
      select: { createdAt: true },
      orderBy: { createdAt: 'asc' },
    });
    const dayKeys = [...new Set(posts.map((p) => easternDayKey(p.createdAt)))].sort();
    const stats = computeCheckinStreakStats({
      dayKeys,
      todayKey: easternDayKey(now),
      yesterdayKey: yesterdayEasternDayKey(now),
    });
    await tx.user.update({
      where: { id: userId },
      data: {
        checkinStreakDays: stats.currentStreakDays,
        longestStreakDays: stats.longestStreakDays,
        lastCheckinDayKey: stats.lastCheckinDayKey,
      },
    });
  }

  private async getSiteConfig() {
    // Low-churn single row; cache briefly to avoid a DB hit on every create.
    const now = Date.now();
    if (this.siteConfigCache && this.siteConfigCache.expiresAt > now) return this.siteConfigCache.value;

    const cfg = await this.prisma.siteConfig.findUnique({ where: { id: 1 } });
    // If missing (shouldn't happen after migrations), use safe defaults.
    const value =
      cfg ??
      ({
        id: 1,
        postsPerWindow: 5,
        windowSeconds: 300,
        verifiedPostsPerWindow: 5,
        verifiedWindowSeconds: 300,
        premiumPostsPerWindow: 5,
        premiumWindowSeconds: 300,
      } as const);
    this.siteConfigCache = { value, expiresAt: now + 5 * 60 * 1000 };
    return value;
  }

  private siteConfigCache: {
    value: {
      id: number;
      postsPerWindow: number;
      windowSeconds: number;
      verifiedPostsPerWindow: number;
      verifiedWindowSeconds: number;
      premiumPostsPerWindow: number;
      premiumWindowSeconds: number;
    };
    expiresAt: number;
  } | null = null;

  invalidateSiteConfigCache() {
    this.siteConfigCache = null;
  }

  async deletePost(params: { userId: string; postId: string }) {
    const { userId, postId } = params;
    const id = (postId ?? '').trim();
    if (!id) throw new NotFoundException('Post not found.');

    const post = await this.prisma.post.findUnique({
      where: { id },
      select: {
        id: true,
        userId: true,
        deletedAt: true,
        hashtags: true,
        hashtagCasings: true,
        cashtags: true,
        topics: true,
        kind: true,
        parentId: true,
        repostedPostId: true,
        quotedPostId: true,
      },
    });
    if (!post) throw new NotFoundException('Post not found.');
    if (post.userId !== userId) throw new ForbiddenException('Not allowed to delete this post.');
    if (post.deletedAt) return { success: true };

    const postTopics = post.topics ?? [];
    const tags = post.hashtags ?? [];
    const variants = post.hashtagCasings ?? [];
    const now = new Date();
    await this.prisma.$transaction(async (tx) => {
      await tx.post.update({
        where: { id },
        data: { deletedAt: now },
      });

      // Decrement commentCount on the parent post when a comment is deleted.
      // Use raw SQL GREATEST(0, ...) to prevent the counter going negative under races.
      const parentId = post.parentId;
      if (parentId) {
        await tx.$executeRaw`
          UPDATE "Post"
          SET "commentCount" = GREATEST(0, "commentCount" - 1)
          WHERE "id" = ${parentId}
        `.catch(() => { /* ignore if parent is gone */ });
      }

      // Decrement repostCount on the target post when a repost/quote repost is deleted.
      const repostedPostId = post.repostedPostId;
      const quotedPostId = post.quotedPostId;
      if (post.kind === 'repost' && repostedPostId) {
        await tx.post.update({
          where: { id: repostedPostId },
          data: { repostCount: { decrement: 1 } },
        }).catch(() => { /* ignore if original is gone */ });
      } else if (quotedPostId) {
        await tx.post.update({
          where: { id: quotedPostId },
          data: { repostCount: { decrement: 1 } },
        }).catch(() => { /* ignore if quoted is gone */ });
      }

      // Poll cleanup: once a post is deleted, we should never send "poll results ready" notifications.
      // This also prevents notifications if the post is later restored by an admin.
      await tx.postPoll.updateMany({
        where: { postId: id, resultsNotifiedAt: null },
        data: { resultsNotifiedAt: now },
      });

      // Posts are soft-deleted, so FK cascades won't run. Ensure bookmarks don't retain deleted posts.
      // (BookmarkCollectionItem cascades off Bookmark, so folder links are cleaned up too.)
      await tx.bookmark.deleteMany({ where: { postId: id } });

      if (tags.length > 0) {
        for (let i = 0; i < tags.length; i++) {
          const t = (tags[i] ?? '').trim().toLowerCase();
          const variant = (variants[i] ?? '').trim();
          if (!t) continue;
          try {
            await tx.hashtag.update({
              where: { tag: t },
              data: { usageCount: { decrement: 1 } },
            });
          } catch {
            // ignore: missing hashtag row (best-effort counters)
          }
          if (variant) {
            try {
              await tx.hashtagVariant.update({
                where: { tag_variant: { tag: t, variant } },
                data: { count: { decrement: 1 } },
              });
            } catch {
              // ignore
            }
          }
        }
        await tx.hashtagVariant.deleteMany({ where: { tag: { in: tags }, count: { lte: 0 } } });
        await tx.hashtag.deleteMany({ where: { tag: { in: tags }, usageCount: { lte: 0 } } });
      }

      // Deleted posts should no longer contribute to current/best streaks.
      // Recompute from remaining non-deleted, non-onlyMe post days.
      await this.recomputeStreakFromPostsTx(tx as Prisma.TransactionClient, userId, now);
    });

    // Delete all notifications that reference this post (as subject) or were caused by this post (as actorPost).
    // Best-effort: deleting a post should not fail due to notification cleanup.
    await Promise.allSettled([
      this.notifications.deleteBySubjectPostId(id),
      this.notifications.deleteByActorPostId(id),
    ]).catch(() => {});
    await this.cacheInvalidation.bumpForPostWrite({ topics: postTopics });

    // Refresh trending score for the post that lost a comment/repost due to this deletion.
    const affectedPostId = post.repostedPostId ?? post.quotedPostId ?? null;
    if (affectedPostId) this.ranking.enqueueScoreRefresh(affectedPostId);

    // Realtime: mark post deleted for live subscribers (best-effort).
    try {
      this.presenceRealtime.emitPostsLiveUpdated(id, {
        postId: id,
        version: now.toISOString(),
        reason: 'post_deleted',
        patch: { deletedAt: now.toISOString() },
      });
    } catch {
      // Best-effort
    }

    // Realtime: decrement parent commentCount + notify thread subscribers of the delete (best-effort).
    const deletedParentId = post.parentId;
    if (deletedParentId) {
      // Emit the structural delete hint FIRST so thread subscribers remove the reply
      // from their local list, then send the authoritative `commentCount` patch. If
      // we did this in the opposite order, the `liveUpdated` patch would set the
      // count to N-1 and `commentDeleted` would then decrement again to N-2, since
      // the per-permalink `onCommentDeleted` handler decrements when it removes the
      // row from its array.
      try {
        this.presenceRealtime.emitPostsCommentDeleted(deletedParentId, {
          parentPostId: deletedParentId,
          commentId: id,
        });
      } catch {
        // Best-effort
      }

      try {
        const updatedParent = await this.prisma.post.findUnique({
          where: { id: deletedParentId },
          select: { commentCount: true },
        });
        if (updatedParent && typeof updatedParent.commentCount === 'number') {
          this.presenceRealtime.emitPostsLiveUpdated(deletedParentId, {
            postId: deletedParentId,
            version: now.toISOString(),
            reason: 'comment_deleted',
            patch: { commentCount: updatedParent.commentCount },
          });
        }
      } catch {
        // Best-effort
      }
    }

    return { success: true };
  }

  async updatePost(params: { userId: string; postId: string; body: string; isSiteAdmin?: boolean }) {
    const { userId, postId } = params;
    const id = (postId ?? '').trim();
    if (!id) throw new NotFoundException('Post not found.');

    const nextBody = (params.body ?? '').trim();
    if (!nextBody) throw new BadRequestException('Post must include text.');

    const post = await this.prisma.post.findUnique({
      where: { id },
      include: {
        user: { select: USER_LIST_SELECT },
        media: { orderBy: { position: 'asc' } },
        mentions: { select: { userId: true } },
        poll: { select: { id: true, totalVoteCount: true } },
      },
    });
    if (!post) throw new NotFoundException('Post not found.');
    if (post.userId !== userId) throw new ForbiddenException('Not allowed to edit this post.');
    if (post.deletedAt) throw new ForbiddenException('Cannot edit a deleted post.');
    if (post.parentId) throw new ForbiddenException('Replies cannot be edited.');

    // Product rule: posts with polls cannot be edited once voting begins.
    if (post.poll && (post.poll.totalVoteCount ?? 0) > 0) {
      throw new ForbiddenException('This post can no longer be edited.');
    }

    // Only-me posts and siteAdmins are exempt from age/count limits.
    if (post.visibility !== 'onlyMe' && !params.isSiteAdmin) {
      // Enforce edit window + count: 3 edits in first 30 minutes after creation.
      const now = Date.now();
      const createdAtMs = post.createdAt.getTime();
      const windowMs = 30 * 60 * 1000;
      if (Number.isFinite(createdAtMs) && now > createdAtMs + windowMs) {
        throw new ForbiddenException('This post can no longer be edited.');
      }
      if (post.editCount >= 3) throw new ForbiddenException('This post has reached the edit limit.');
    }

    // Length rules align with createPost.
    const isAuthorPremium = Boolean(post.user?.premium || post.user?.premiumPlus);
    const maxLen = isAuthorPremium ? 1000 : 500;
    if (nextBody.length > maxLen) {
      throw new BadRequestException(
        isAuthorPremium ? 'Posts are limited to 1000 characters.' : 'Posts are limited to 500 characters.',
      );
    }

    const hashtagTokensRaw = this.parseHashtagsFromBody(nextBody);
    const hashtagTokens = hashtagTokensRaw
      .map((t) => ({ tag: (t.tag ?? '').trim().toLowerCase(), variant: (t.variant ?? '').trim() }))
      .filter((t) => Boolean(t.tag && t.variant));
    hashtagTokens.sort((a, b) => a.tag.localeCompare(b.tag) || a.variant.localeCompare(b.variant));
    const hashtags = hashtagTokens.map((t) => t.tag);
    const hashtagCasings = hashtagTokens.map((t) => t.variant);
    const cashtags = this.parseCashtagsFromBody(nextBody);

    const fromBodyMentions = this.parseMentionsFromBody(nextBody);
    const bodyMentionIds = await this.resolveMentionUsernames(fromBodyMentions);
    const existingMentionIds = (post.mentions ?? []).map((m) => m.userId);
    const mentionUserIds = Array.from(new Set([...existingMentionIds, ...bodyMentionIds])).filter(Boolean);

    const prevTopics = post.topics ?? [];
    const updated = await this.prisma.$transaction(async (tx) => {
      // Snapshot previous state (pre-edit).
      await tx.postVersion.create({
        data: {
          postId: post.id,
          body: post.body,
          topics: post.topics ?? [],
          hashtags: post.hashtags ?? [],
          hashtagCasings: post.hashtagCasings ?? [],
          cashtags: (post as any).cashtags ?? [],
          visibility: post.visibility,
        },
      });

      // Recompute topics from text and hashtags (no related topics for root post edits).
      const topics = inferTopicsFromText(nextBody, { hashtags, relatedTopics: [] });

      const next = await tx.post.update({
        where: { id: post.id },
        data: {
          body: nextBody,
          topics,
          hashtags,
          hashtagCasings,
          cashtags,
          editedAt: new Date(),
          editCount: { increment: 1 },
        },
        include: {
          user: { select: USER_LIST_SELECT },
          media: { orderBy: { position: 'asc' } },
          mentions: {
            include: {
              user: {
                select: MENTION_USER_SELECT,
              },
            },
          },
        },
      });

      await tx.postMention.deleteMany({ where: { postId: post.id } });
      if (mentionUserIds.length > 0) {
        await tx.postMention.createMany({
          data: mentionUserIds.map((uid) => ({ postId: post.id, userId: uid })),
          skipDuplicates: true,
        });
      }

      // If hashtags changed, best-effort adjust counters by recomputing counts deltas.
      // We keep it simple for v1: decrement old and increment new based on tokens.
      const prevTags = post.hashtags ?? [];
      const prevVariants = post.hashtagCasings ?? [];
      const prevPairs = prevTags.map((t, i) => ({ tag: (t ?? '').trim().toLowerCase(), variant: (prevVariants[i] ?? '').trim() })).filter((x) => x.tag);
      const nextPairs = hashtagTokens;

      const prevKeyCount = new Map<string, number>();
      for (const p of prevPairs) prevKeyCount.set(`${p.tag}\n${p.variant}`, (prevKeyCount.get(`${p.tag}\n${p.variant}`) ?? 0) + 1);
      const nextKeyCount = new Map<string, number>();
      for (const p of nextPairs) nextKeyCount.set(`${p.tag}\n${p.variant}`, (nextKeyCount.get(`${p.tag}\n${p.variant}`) ?? 0) + 1);

      const allKeys = new Set<string>([...prevKeyCount.keys(), ...nextKeyCount.keys()]);
      for (const key of allKeys) {
        const [tag, variant] = key.split('\n');
        const prevN = prevKeyCount.get(key) ?? 0;
        const nextN = nextKeyCount.get(key) ?? 0;
        const delta = nextN - prevN;
        if (!tag || delta === 0) continue;
        if (delta > 0) {
          await tx.hashtag.upsert({
            where: { tag },
            create: { tag, usageCount: delta },
            update: { usageCount: { increment: delta } },
          });
          if (variant) {
            await tx.hashtagVariant.upsert({
              where: { tag_variant: { tag, variant } },
              create: { tag, variant, count: delta },
              update: { count: { increment: delta } },
            });
          }
        } else if (delta < 0) {
          try {
            await tx.hashtag.update({ where: { tag }, data: { usageCount: { decrement: Math.abs(delta) } } });
          } catch {
            // ignore
          }
          if (variant) {
            try {
              await tx.hashtagVariant.update({ where: { tag_variant: { tag, variant } }, data: { count: { decrement: Math.abs(delta) } } });
            } catch {
              // ignore
            }
          }
        }
      }
      const allTagsTouched = Array.from(new Set([...prevTags, ...hashtags].map((t) => String(t ?? '').trim().toLowerCase()).filter(Boolean)));
      await tx.hashtagVariant.deleteMany({ where: { tag: { in: allTagsTouched }, count: { lte: 0 } } });
      await tx.hashtag.deleteMany({ where: { tag: { in: allTagsTouched }, usageCount: { lte: 0 } } });

      return next;
    });
    const nextTopics = updated.topics ?? [];
    await this.cacheInvalidation.bumpForPostWrite({ topics: [...prevTopics, ...nextTopics] });

    // Realtime: update body/edited markers for live subscribers (best-effort).
    try {
      const editedAtIso = (updated.editedAt ?? new Date()).toISOString();
      const editCount = typeof updated.editCount === 'number' ? updated.editCount : undefined;
      this.presenceRealtime.emitPostsLiveUpdated(id, {
        postId: id,
        version: editedAtIso,
        reason: 'post_edited',
        patch: {
          body: String(updated.body ?? ''),
          editedAt: editedAtIso,
          ...(typeof editCount === 'number' ? { editCount } : {}),
        },
      });
    } catch {
      // Best-effort
    }
    return updated;
  }

  async publishFromOnlyMe(params: {
    userId: string;
    sourcePostId: string;
    body: string | null;
    visibility: PostVisibility;
    media?: Array<
      | { source: 'existing'; id: string; alt?: string | null }
      | {
          source: 'upload';
          kind: 'image' | 'gif' | 'video';
          r2Key?: string;
          thumbnailR2Key?: string;
          url?: string;
          mp4Url?: string;
          width?: number;
          height?: number;
          durationSeconds?: number;
          alt?: string | null;
        }
      | {
          source: 'giphy';
          kind: 'gif';
          url: string;
          mp4Url?: string;
          width?: number;
          height?: number;
          alt?: string | null;
        }
    > | null;
  }) {
    const sourceId = (params.sourcePostId ?? '').trim();
    if (!sourceId) throw new NotFoundException('Post not found.');

    const source = await this.prisma.post.findUnique({
      where: { id: sourceId },
      include: { media: { orderBy: { position: 'asc' } } },
    });
    if (!source) throw new NotFoundException('Post not found.');
    if (source.userId !== params.userId) throw new ForbiddenException('Not allowed.');
    if (source.deletedAt) throw new NotFoundException('Post not found.');
    if (source.visibility !== 'onlyMe') throw new ForbiddenException('Not allowed.');
    if (source.parentId) throw new ForbiddenException('Not allowed.');

    const body = (params.body ?? source.body ?? '').trim();

    const sourceMediaSorted = (source.media ?? [])
      .slice()
      .sort((a, b) => (a.position ?? 0) - (b.position ?? 0));

    const requested = (params.media ?? null) as (NonNullable<(typeof params)['media']>) | null;

    const media = requested
      ? requested.map((m) => {
          if (m.source === 'existing') {
            const id = (m.id ?? '').trim();
            if (!id) throw new BadRequestException('Invalid media item.');
            const found = sourceMediaSorted.find((sm) => sm.id === id && !sm.deletedAt);
            if (!found) throw new BadRequestException('Invalid media item.');
            const alt = (m.alt ?? '').trim() || (found.alt ?? '').trim() || null;
            return {
              source: found.source === 'giphy' ? ('giphy' as const) : ('upload' as const),
              kind: found.kind as 'image' | 'gif' | 'video',
              r2Key: found.r2Key ?? undefined,
              thumbnailR2Key: found.thumbnailR2Key ?? undefined,
              url: found.url ?? undefined,
              mp4Url: found.mp4Url ?? undefined,
              width: found.width ?? undefined,
              height: found.height ?? undefined,
              durationSeconds: found.durationSeconds ?? undefined,
              alt,
            };
          }
          if (m.source === 'giphy') {
            return {
              source: 'giphy' as const,
              kind: 'gif' as const,
              url: m.url,
              mp4Url: m.mp4Url ?? undefined,
              width: m.width ?? undefined,
              height: m.height ?? undefined,
              alt: (m.alt ?? '').trim() || null,
            };
          }
          // upload
          return {
            source: 'upload' as const,
            kind: m.kind,
            r2Key: m.r2Key ?? undefined,
            thumbnailR2Key: m.thumbnailR2Key ?? undefined,
            width: m.width ?? undefined,
            height: m.height ?? undefined,
            durationSeconds: m.durationSeconds ?? undefined,
            alt: (m.alt ?? '').trim() || null,
          };
        })
      : sourceMediaSorted.map((m) => ({
          source: m.source === 'giphy' ? ('giphy' as const) : ('upload' as const),
          kind: m.kind as 'image' | 'gif' | 'video',
          r2Key: m.r2Key ?? undefined,
          thumbnailR2Key: m.thumbnailR2Key ?? undefined,
          url: m.url ?? undefined,
          mp4Url: m.mp4Url ?? undefined,
          width: m.width ?? undefined,
          height: m.height ?? undefined,
          durationSeconds: m.durationSeconds ?? undefined,
          alt: (m.alt ?? '').trim() || null,
        }));

    const createdBundle = await this.createPost({
      userId: params.userId,
      body,
      visibility: params.visibility,
      parentId: null,
      mentions: null,
      media: media.length ? media : null,
      poll: null,
    });
    const postId = createdBundle.post.id;

    // Fetch with mentions for UI consistency (createPost already bumped caches for non–onlyMe).
    const full = await this.prisma.post.findUnique({
      where: { id: postId },
      include: {
        user: { select: USER_LIST_SELECT },
        media: { orderBy: { position: 'asc' } },
        poll: { include: { options: { orderBy: { position: 'asc' } } } },
        mentions: {
          include: {
            user: {
              select: MENTION_USER_SELECT,
            },
          },
        },
      },
    });
    return full ?? createdBundle.post;
  }

  /** Resolve usernames to user ids (case-insensitive, usernameIsSet). Invalid usernames ignored. */
  private async resolveMentionUsernames(usernames: string[]): Promise<string[]> {
    return await resolveMentionUsernamesQuery(this.prisma, usernames);
  }

  /**
   * Resolve a list of @usernames to a lowercased-username → userId map in a single query.
   * Used by createPost to avoid running the same query twice (for body mentions vs. all mentions).
   */
  private async resolveMentionUsernamesMap(usernames: string[]): Promise<Map<string, string>> {
    return await resolveMentionUsernamesMapQuery(this.prisma, usernames);
  }

  /** Parse @username tokens from body: letter then 0–14 [A-Za-z0-9_] (1–15 chars), not mid-email. */
  private parseMentionsFromBody(body: string): string[] {
    return parseMentionsFromBodyText(body);
  }

  /** Parse #hashtag tokens from body: letter then [A-Za-z0-9_], stored lowercase without '#'. */
  private parseHashtagsFromBody(body: string): HashtagToken[] {
    return parseHashtagTokensFromText(body);
  }

  /** Parse $SYMBOL candidates from body and return only those present in the ticker universe. */
  private parseCashtagsFromBody(body: string): string[] {
    const candidates = parseCashtagCandidatesFromText(body);
    return candidates.filter((s) => this.ticker.isValid(s));
  }

  /** Thread participant role for reply notifications. */
  private static readonly REPLY_TITLE = {
    root_author: "replied to your post",
    reply_author: "replied to your comment",
    mentioned_in_root: "replied to a post you're mentioned in",
    mentioned_in_reply: "replied to a comment you're mentioned in",
  } as const;

  /**
   * Compute thread participant roles by walking the parent chain in memory.
   *
   * `threadPosts` is the full thread tree (root + descendants) already fetched
   * once during `createPost`. Walking in memory avoids one DB round trip per
   * ancestor, which dominated reply latency on deep threads.
   */
  private computeThreadRolesFromPosts(
    threadPosts: Array<{ id: string; parentId: string | null; userId: string; mentions: { userId: string }[] }>,
    parentId: string,
  ): Map<string, keyof typeof PostsMutationService.REPLY_TITLE> {
    const map = new Map<string, keyof typeof PostsMutationService.REPLY_TITLE>();
    const byId = new Map(threadPosts.map((p) => [p.id, p]));
    let currentId: string | null = parentId;
    while (currentId) {
      const post = byId.get(currentId);
      if (!post) break;
      const isRoot = !post.parentId;
      const authorRole = isRoot ? 'root_author' : 'reply_author';
      const mentionRole = isRoot ? 'mentioned_in_root' : 'mentioned_in_reply';
      if (!map.has(post.userId)) map.set(post.userId, authorRole);
      for (const m of post.mentions) {
        if (!map.has(m.userId)) map.set(m.userId, mentionRole);
      }
      currentId = post.parentId;
    }
    return map;
  }

  async createPost(params: {
    userId: string;
    body: string;
    visibility: PostVisibility;
    parentId?: string | null;
    mentions?: string[] | null;
    media: Array<{
      source: 'upload' | 'giphy';
      kind: 'image' | 'gif' | 'video';
      r2Key?: string;
      thumbnailR2Key?: string;
      url?: string;
      mp4Url?: string;
      width?: number;
      height?: number;
      durationSeconds?: number;
      alt?: string | null;
    }> | null;
    poll: {
      endsAt: Date;
      options: Array<{
        text: string;
        image: { r2Key: string; width: number | null; height: number | null; alt: string | null } | null;
      }>;
    } | null;
    kind?: 'regular' | 'checkin';
    checkinDayKey?: string | null;
    checkinPrompt?: string | null;
    /** Top-level post only: creates a post inside this community group (membership required). */
    communityGroupId?: string | null;
    /**
     * Optional Marv reply-mode hint, sourced from the `x-marv-mode` request header. Only
     * has any effect when @marv is mentioned in the body — the public-reply processor reads
     * this off the enqueued job to choose the OpenAI model. Ignored otherwise.
     */
    marvMode?: 'fast' | 'regular' | 'smart' | null;
  }) {
    const { userId, body, visibility: requestedVisibility, parentId, mentions: clientMentions } = params;
    const requestedMarvMode = params.marvMode ?? null;
    const requestedCommunityGroupId = (params.communityGroupId ?? '').trim() || null;
    const kind = (params.kind ?? 'regular') as 'regular' | 'checkin';
    const now = new Date();
    const checkinDayKeyRaw = (params.checkinDayKey ?? null)?.trim() || null;
    const checkinPromptRaw = (params.checkinPrompt ?? null)?.trim() || null;

    if (kind === 'checkin') {
      if (requestedCommunityGroupId) {
        throw new BadRequestException('Check-ins cannot be posted inside a community group.');
      }
      if (parentId) throw new BadRequestException('Check-ins must be top-level posts.');
      if (requestedVisibility !== 'verifiedOnly' && requestedVisibility !== 'premiumOnly') {
        throw new BadRequestException('Check-ins must be verified-only or premium-only.');
      }
      const todayKey = easternDayKey(now);
      if (!checkinDayKeyRaw || checkinDayKeyRaw !== todayKey) {
        throw new BadRequestException('Invalid check-in day.');
      }
      if (!checkinPromptRaw) throw new BadRequestException('Check-in prompt is required.');
    }

    // Fetch viewer context (request-cached) and parent post in parallel.
    // Using viewerContextService populates the per-request cache so subsequent
    // `getViewer(userId)` calls (incl. the controller's `viewerContext()`) are free.
    const [viewer, parentPost] = await Promise.all([
      this.viewerContextService.getViewer(userId),
      parentId
        ? this.prisma.post.findFirst({
            where: { id: parentId, ...notDeletedWhere() },
            select: { id: true, userId: true, visibility: true, rootId: true, topics: true, communityGroupId: true },
          })
        : Promise.resolve(null),
    ]);
    if (!viewer) throw new NotFoundException('User not found.');
    this.viewerContextService.assertNotBanned(viewer);
    if (parentId && !parentPost) throw new NotFoundException('Post not found.');
    const user = { verifiedStatus: viewer.verifiedStatus, premium: viewer.premium, premiumPlus: viewer.premiumPlus };
    const viewerIsVerified = Boolean(viewer.verifiedStatus && viewer.verifiedStatus !== 'none');

    // Product rule: unverified users cannot create new public feed posts.
    // (UI already hides this, but enforce on the API too.)
    if (!viewerIsVerified && !parentId && requestedVisibility === 'public' && !requestedCommunityGroupId) {
      throw new ForbiddenException('Verify your account to create public posts.');
    }
    // Creation is gated by current tier: downgraded users can only create within their tier.
    const allowedForCreation = this.enrichment.allowedVisibilitiesForViewer(viewer);
    const skipTierVisibilityForCommunityGroupRoot = Boolean(!parentId && requestedCommunityGroupId);
    if (requestedVisibility !== 'onlyMe' && !allowedForCreation.includes(requestedVisibility)) {
      if (!skipTierVisibilityForCommunityGroupRoot) {
        if (requestedVisibility === 'verifiedOnly') throw new ForbiddenException('Verify your account to create verified-only posts.');
        if (requestedVisibility === 'premiumOnly') throw new ForbiddenException('Upgrade to premium to create premium-only posts.');
        throw new ForbiddenException('You cannot create posts with that visibility.');
      }
    }

    let visibility: PostVisibility = requestedVisibility;
    let resolvedCommunityGroupId: string | null = null;
    let threadParticipantIds: string[] = [];
    let parentAuthorUserId: string | null = null;
    let threadRootId: string | null = null; // Root post ID for thread hierarchy
    let parentTopics: string[] = [];
    let rootTopics: string[] = [];
    type ThreadPostForRoles = { id: string; parentId: string | null; userId: string; mentions: { userId: string }[] };
    let threadPostsForRoles: ThreadPostForRoles[] = [];

    if (parentId && parentPost) {
      parentAuthorUserId = parentPost.userId;
      parentTopics = Array.isArray(parentPost.topics) ? (parentPost.topics as string[]) : [];
      if (parentPost.visibility === 'onlyMe') {
        throw new ForbiddenException('Replies are not allowed on only-me posts.');
      }
      const parentGid = parentPost.communityGroupId ?? null;
      const isCrossUser = Boolean(parentAuthorUserId && parentAuthorUserId !== userId);
      // Use parent's rootId if it exists (parent is also a reply), otherwise parent.id is the root
      threadRootId = (parentPost as { rootId?: string | null }).rootId ?? parentPost.id;
      const needsRootTopics = Boolean(threadRootId && threadRootId !== parentPost.id);

      // Fan out parent-dependent reads in one round trip:
      //   block check, group membership, root-for-topics, thread tree.
      const [blockCount, groupMember, rootForTopics, threadPosts] = await Promise.all([
        isCrossUser
          ? this.prisma.userBlock.count({
              where: {
                OR: [
                  { blockerId: userId, blockedId: parentAuthorUserId! },
                  { blockerId: parentAuthorUserId!, blockedId: userId },
                ],
              },
            })
          : Promise.resolve(0),
        parentGid
          ? this.prisma.communityGroupMember.findUnique({
              where: { groupId_userId: { groupId: parentGid, userId } },
              select: { status: true },
            })
          : Promise.resolve(null),
        needsRootTopics
          ? this.prisma.post.findFirst({
              where: { id: threadRootId, ...notDeletedWhere() },
              select: { topics: true },
            })
          : Promise.resolve(null),
        this.prisma.post.findMany({
          where: { OR: [{ id: threadRootId }, { rootId: threadRootId }], ...notDeletedWhere() },
          select: { id: true, parentId: true, userId: true, mentions: { select: { userId: true } } },
        }),
      ]);

      if (blockCount > 0) throw new ForbiddenException('You cannot reply to this post.');

      if (parentGid) {
        if (requestedCommunityGroupId && requestedCommunityGroupId !== parentGid) {
          throw new BadRequestException('Invalid community group for this thread.');
        }
        resolvedCommunityGroupId = parentGid;
        if (!groupMember || groupMember.status !== 'active') {
          throw new ForbiddenException('Join this group to reply in this thread.');
        }
        visibility = 'public';
      } else {
        if (requestedCommunityGroupId) {
          throw new BadRequestException('This thread is not in a community group.');
        }
        if (!viewerIsVerified && parentPost.visibility === 'public') {
          throw new ForbiddenException('Verify your account to reply publicly.');
        }
        const allowed = this.enrichment.allowedVisibilitiesForViewer(viewer);
        const isSelf = parentPost.userId === userId;
        if (!isSelf) {
          if (!allowed.includes(parentPost.visibility)) {
            if (parentPost.visibility === 'verifiedOnly') throw new ForbiddenException('Verify to view verified-only posts.');
            if (parentPost.visibility === 'premiumOnly') throw new ForbiddenException('Upgrade to premium to view premium-only posts.');
            throw new ForbiddenException('Not allowed to reply to this post.');
          }
        }
        visibility = parentPost.visibility as PostVisibility;
      }

      rootTopics = needsRootTopics
        ? (Array.isArray(rootForTopics?.topics) ? ((rootForTopics?.topics ?? []) as string[]) : [])
        : parentTopics;

      threadPostsForRoles = threadPosts;
      const participantIds = new Set<string>();
      for (const p of threadPosts) {
        participantIds.add(p.userId);
        for (const m of p.mentions) participantIds.add(m.userId);
      }
      threadParticipantIds = Array.from(participantIds);
    } else if (requestedCommunityGroupId) {
      resolvedCommunityGroupId = requestedCommunityGroupId;
      const mem = await this.prisma.communityGroupMember.findUnique({
        where: { groupId_userId: { groupId: resolvedCommunityGroupId, userId } },
        select: { status: true },
      });
      if (!mem || mem.status !== 'active') {
        throw new ForbiddenException('Join this group to post here.');
      }
      visibility = 'public';
    }

    // Compute rate-limit window parameters synchronously; the actual count query is
    // batched in parallel with media-hash + mention resolution below.
    let rateLimitParams: { postsPerWindow: number; windowSeconds: number; windowStart: Date } | null = null;
    if (viewerIsVerified) {
      const cfg = await this.getSiteConfig(); // in-memory cached; near-free
      const isPremium = Boolean(user.premium || user.premiumPlus);
      const postsPerWindow = isPremium ? cfg.premiumPostsPerWindow : cfg.verifiedPostsPerWindow;
      const windowSeconds = isPremium ? cfg.premiumWindowSeconds : cfg.verifiedWindowSeconds;
      const windowStart = new Date(Date.now() - windowSeconds * 1000);
      rateLimitParams = { postsPerWindow, windowSeconds, windowStart };
    }

    const viewerIsPremium = Boolean(user.premium || user.premiumPlus);
    const maxLen = viewerIsPremium ? 1000 : 500;
    if (body.length > maxLen) {
      throw new BadRequestException(
        viewerIsPremium ? 'Posts are limited to 1000 characters.' : 'Posts are limited to 500 characters.',
      );
    }

    const media = (params.media ?? []).filter(Boolean);
    if (media.length > 4) throw new BadRequestException('You can attach up to 4 images, GIFs, or videos.');

    const poll = params.poll;
    if (poll && resolvedCommunityGroupId) {
      throw new BadRequestException('Polls are not supported in community groups.');
    }
    if (poll && parentId) {
      throw new ForbiddenException('Polls are not allowed on replies.');
    }
    if (poll && media.length > 0) {
      throw new BadRequestException('You cannot attach media to a poll post.');
    }
    // Product rule: polls require verified membership.
    if (poll && !viewerIsVerified) {
      throw new ForbiddenException('Verify your account to create polls.');
    }
    if (poll) {
      const endsAtMs =
        poll.endsAt instanceof Date
          ? poll.endsAt.getTime()
          : new Date(poll.endsAt as string | number).getTime();
      const now = Date.now();
      const maxMs = 7 * 24 * 60 * 60 * 1000;
      if (!Number.isFinite(endsAtMs) || endsAtMs <= now) throw new BadRequestException('Invalid poll duration.');
      if (endsAtMs > now + maxMs) throw new BadRequestException('Poll duration must be 7 days or shorter.');
      const opts = Array.isArray(poll.options) ? poll.options : [];
      if (opts.length < 2 || opts.length > 5) throw new BadRequestException('Poll must include 2 to 5 options.');
    }

    // Images/GIFs require verified; video requires premium.
    const hasVideo = media.some((m) => m.kind === 'video');
    const hasImageOrGif = media.some((m) => m.kind !== 'video');
    if (hasImageOrGif && !viewerIsVerified) {
      throw new ForbiddenException('Verify your account to post images and GIFs.');
    }
    if (hasVideo && !viewerIsPremium) {
      throw new ForbiddenException('Video posts are for premium members only.');
    }

    const allowedImagePrefixes = [`uploads/${userId}/images/`, `dev/uploads/${userId}/images/`];
    const allowedVideoPrefixes = [`uploads/${userId}/videos/`, `dev/uploads/${userId}/videos/`];
    const allowedThumbnailPrefixes = [`uploads/${userId}/thumbnails/`, `dev/uploads/${userId}/thumbnails/`];

    // Keys that exist in MediaContentHash (reused uploads from any user) are allowed.
    const pollImageKeys = (poll?.options ?? [])
      .map((o) => (o?.image?.r2Key ?? '').trim())
      .filter(Boolean);
    const uploadKeys = [
      ...media
        .filter((m) => m.source === 'upload' && (m.r2Key ?? '').trim())
        .map((m) => (m.r2Key ?? '').trim()),
      ...pollImageKeys,
    ];

    // Pre-compute mention username sets so we can do the rate-limit count, media-hash
    // lookup and (single) mention resolution in one round trip.
    const fromBody = this.parseMentionsFromBody(body);
    const clientUsernames = Array.isArray(clientMentions) ? clientMentions.filter((x) => typeof x === 'string' && x.length <= 120) : [];
    const allUsernames = [...new Set([...clientUsernames, ...fromBody])];

    const [recentPostCount, reusedKeyRows, mentionUsernameToId] = await Promise.all([
      rateLimitParams
        ? this.prisma.post.count({
            where: { userId, createdAt: { gte: rateLimitParams.windowStart }, visibility: { not: 'onlyMe' } },
          })
        : Promise.resolve(0),
      uploadKeys.length
        ? this.prisma.mediaContentHash.findMany({ where: { r2Key: { in: uploadKeys } }, select: { r2Key: true } })
        : Promise.resolve([] as Array<{ r2Key: string }>),
      // Single resolution covers both body mentions and thread-participant client mentions.
      this.resolveMentionUsernamesMap(allUsernames),
    ]);

    if (rateLimitParams && recentPostCount >= rateLimitParams.postsPerWindow) {
      const minutes = Math.max(1, Math.round(rateLimitParams.windowSeconds / 60));
      const minuteLabel = minutes === 1 ? 'minute' : 'minutes';
      throw new HttpException(
        `You are posting too often. You can make up to ${rateLimitParams.postsPerWindow} posts every ${minutes} ${minuteLabel}.`,
        HttpStatus.TOO_MANY_REQUESTS,
      );
    }

    const reusedKeySet = new Set(reusedKeyRows.map((r) => r.r2Key));

    const cleanedMedia = media
      .map((m, idx) => {
        const source = m.source;
        const kind = m.kind;
        const r2Key = (m.r2Key ?? '').trim();
        const thumbnailR2Key = (m.thumbnailR2Key ?? '').trim() || null;
        const url = (m.url ?? '').trim();
        const mp4Url = (m.mp4Url ?? '').trim();
        const width = typeof m.width === 'number' && Number.isFinite(m.width) ? Math.max(1, Math.floor(m.width)) : null;
        const height = typeof m.height === 'number' && Number.isFinite(m.height) ? Math.max(1, Math.floor(m.height)) : null;
        const durationSeconds =
          typeof m.durationSeconds === 'number' && Number.isFinite(m.durationSeconds) && m.durationSeconds >= 0
            ? Math.floor(m.durationSeconds)
            : null;
        const alt = (m.alt ?? '').trim().slice(0, 500) || null;

        if (source === 'upload') {
          if (!r2Key) throw new BadRequestException('Invalid uploaded media key.');
          const isReusedKey = reusedKeySet.has(r2Key);
          if (kind === 'video') {
            if (!isReusedKey && !allowedVideoPrefixes.some((p) => r2Key.startsWith(p))) {
              throw new BadRequestException('Invalid uploaded video key.');
            }
            if (thumbnailR2Key && !allowedThumbnailPrefixes.some((p) => thumbnailR2Key.startsWith(p))) {
              throw new BadRequestException('Invalid thumbnail key.');
            }
            return {
              source,
              kind,
              r2Key,
              thumbnailR2Key: thumbnailR2Key || undefined,
              url: null,
              mp4Url: null,
              width,
              height,
              durationSeconds,
              alt,
              position: idx,
            };
          }
          if (!isReusedKey && !allowedImagePrefixes.some((p) => r2Key.startsWith(p))) {
            throw new BadRequestException('Invalid uploaded media key.');
          }
          return {
            source,
            kind,
            r2Key,
            thumbnailR2Key: undefined,
            url: null,
            mp4Url: null,
            width,
            height,
            durationSeconds: null,
            alt,
            position: idx,
          };
        }

        if (!url) throw new BadRequestException('Invalid Giphy media URL.');
        return {
          source,
          kind,
          r2Key: null,
          thumbnailR2Key: undefined,
          url,
          mp4Url: mp4Url || null,
          width,
          height,
          durationSeconds: null,
          alt,
          position: idx,
        };
      })
      .filter(Boolean);

    const cleanedPollOptions = poll
      ? (poll.options ?? []).map((o, idx) => {
          const text = (o?.text ?? '').trim().slice(0, 30);
          const img = o?.image ?? null;
          if (!text && !img) throw new BadRequestException('Poll option must include text or an image.');
          if (!img) {
            return { text, position: idx, imageR2Key: null as string | null, imageWidth: null as number | null, imageHeight: null as number | null, imageAlt: null as string | null };
          }
          const r2Key = (img.r2Key ?? '').trim();
          if (!r2Key) throw new BadRequestException('Invalid poll option image key.');
          const isReusedKey = reusedKeySet.has(r2Key);
          if (!isReusedKey && !allowedImagePrefixes.some((p) => r2Key.startsWith(p))) {
            throw new BadRequestException('Invalid poll option image key.');
          }
          const width = typeof img.width === 'number' && Number.isFinite(img.width) ? Math.max(1, Math.floor(img.width)) : null;
          const height = typeof img.height === 'number' && Number.isFinite(img.height) ? Math.max(1, Math.floor(img.height)) : null;
          const alt = (img.alt ?? '').trim().slice(0, 500) || null;
          return { text, position: idx, imageR2Key: r2Key, imageWidth: width, imageHeight: height, imageAlt: alt };
        })
      : null;

    // Derive bodyMentionIds (notification priority) and full resolved id set from the
    // single resolution above. fromBody and allUsernames were prepared earlier for parallel batching.
    const bodyMentionIds: string[] = [];
    {
      const seen = new Set<string>();
      const normBody = [...new Set(fromBody.map((u) => u.trim().slice(0, 120)).filter(Boolean))];
      for (const name of normBody) {
        const id = mentionUsernameToId.get(name.toLowerCase());
        if (id && !seen.has(id)) {
          seen.add(id);
          bodyMentionIds.push(id);
        }
      }
    }
    const bodyMentionSet = new Set(bodyMentionIds); // Only body mentions determine notification priority

    const resolvedFromUsernames: string[] = [];
    {
      const seen = new Set<string>();
      const normAll = [...new Set(allUsernames.map((u) => u.trim().slice(0, 120)).filter(Boolean))];
      for (const name of normAll) {
        const id = mentionUsernameToId.get(name.toLowerCase());
        if (id && !seen.has(id)) {
          seen.add(id);
          resolvedFromUsernames.push(id);
        }
      }
    }

    // All mention IDs for PostMention records (include self so @yourname renders as a link)
    const mentionUserIds = [...new Set([...threadParticipantIds, ...resolvedFromUsernames])];

    const hashtagTokensRaw = this.parseHashtagsFromBody(body);
    const hashtagTokens = hashtagTokensRaw
      .map((t) => ({ tag: (t.tag ?? '').trim().toLowerCase(), variant: (t.variant ?? '').trim() }))
      .filter((t) => Boolean(t.tag && t.variant));
    hashtagTokens.sort((a, b) => a.tag.localeCompare(b.tag) || a.variant.localeCompare(b.variant));
    const hashtags = hashtagTokens.map((t) => t.tag);
    const hashtagCasings = hashtagTokens.map((t) => t.variant);
    const cashtags = this.parseCashtagsFromBody(body);

    let parentCommentCount: number | null = null;
    let didAwardStreak = false;
    let streakRewardOut: { coinsEarned: number; streakDays: number; multiplier: 1 | 2 | 3 | 4 } | null = null;
    const quotedPostInfoRef: { current: { quotedAuthorId: string; quotedPostId: string } | null } = { current: null };
    const post = await this.prisma
      .$transaction(async (tx) => {
        const relatedTopics = Array.from(new Set([...(parentTopics ?? []), ...(rootTopics ?? [])])).filter(Boolean);
        const topics = inferTopicsFromText(body, { hashtags, relatedTopics });

        // Detect embedded post link in body up front so we can include `quotedPostId` in the
        // initial create (saves one extra `tx.post.update` round trip when present).
        const detectedQuotedPostId = this.extractQuotedPostIdFromBody(body);
        const quotedExists = detectedQuotedPostId
          ? await tx.post.findFirst({
              where: { id: detectedQuotedPostId, deletedAt: null },
              select: { id: true, userId: true, visibility: true },
            })
          : null;
        const quotedPostIdToSet = quotedExists ? quotedExists.id : null;

        // Quote floor: a quote cannot be more open (less restrictive) than the quoted post.
        // Skipped for replies (visibility inherited from parent) and group posts (forced public).
        if (quotedExists && !parentId && !requestedCommunityGroupId && kind !== 'checkin') {
          if (this.visibilityRank(requestedVisibility) < this.visibilityRank(quotedExists.visibility)) {
            throw new ForbiddenException("A quote can't be more public than the post it quotes.");
          }
        }

        const created = await tx.post.create({
          data: {
            body,
            topics,
            hashtags,
            hashtagCasings,
            cashtags,
            visibility,
            userId,
            kind,
            ...(resolvedCommunityGroupId ? { communityGroupId: resolvedCommunityGroupId } : {}),
            ...(kind === 'checkin'
              ? { checkinDayKey: checkinDayKeyRaw ?? undefined, checkinPrompt: checkinPromptRaw ?? undefined }
              : {}),
            parentId: parentId ?? undefined,
            rootId: threadRootId ?? undefined, // Set root post ID for thread hierarchy
            ...(quotedPostIdToSet ? { quotedPostId: quotedPostIdToSet } : {}),
            ...(cleanedMedia.length
              ? {
                  media: {
                    create: cleanedMedia,
                  },
                }
              : {}),
            ...(mentionUserIds.length
              ? {
                  // Nested-create mentions in the same query so the response includes them
                  // and we don't need a post-transaction findUnique to fetch them.
                  mentions: {
                    create: mentionUserIds.map((uid) => ({ userId: uid })),
                  },
                }
              : {}),
            ...(poll
              ? {
                  poll: {
                    create: {
                      endsAt: poll.endsAt,
                      ...(cleanedPollOptions?.length
                        ? {
                            options: {
                              create: cleanedPollOptions.map((o) => ({
                                text: o.text,
                                position: o.position,
                                imageR2Key: o.imageR2Key ?? undefined,
                                imageWidth: o.imageWidth ?? undefined,
                                imageHeight: o.imageHeight ?? undefined,
                                imageAlt: o.imageAlt ?? undefined,
                              })),
                            },
                          }
                        : {}),
                    },
                  },
                }
              : {}),
          },
          include: {
            user: { select: USER_LIST_SELECT },
            media: { orderBy: { position: 'asc' } },
            mentions: { include: { user: { select: MENTION_USER_SELECT } } },
            poll: { include: { options: { orderBy: { position: 'asc' } } } },
          },
        });

        if (quotedExists) {
          // Store for post-transaction notification (avoid sending inside the transaction).
          quotedPostInfoRef.current = { quotedAuthorId: quotedExists.userId, quotedPostId: quotedExists.id };
        }

        // Streak rewards: daily check + coins (transactional with post creation).
        // Product rule: any non-onlyMe post counts (incl. replies & check-ins). Award once per ET day.
        // CAS guard: updateMany with WHERE lastCheckinDayKey = prevKey prevents a double-award when two
        // concurrent posts run the check at the same time. Only the first writer wins count === 1.
        const streakOp = visibility !== 'onlyMe'
          ? (async () => {
              const todayKey = easternDayKey(now);
              const yesterdayKey = yesterdayEasternDayKey(now);
              const u = await tx.user.findUnique({
                where: { id: userId },
                select: { coins: true, checkinStreakDays: true, lastCheckinDayKey: true, longestStreakDays: true },
              });
              if (!u) throw new NotFoundException('User not found.');
              const prevKey = u.lastCheckinDayKey ?? null;
              if (prevKey === todayKey) return; // already awarded today
              const out = computeCheckinRewards({
                todayKey,
                yesterdayKey,
                lastCheckinDayKey: prevKey,
                currentStreakDays: u.checkinStreakDays ?? 0,
              });
              const nextLongest = Math.max(u.longestStreakDays ?? 0, out.nextStreakDays);
              // Atomic compare-and-swap: only apply when lastCheckinDayKey hasn't changed.
              // If another concurrent post already set it to todayKey, count === 0 and we bail.
              const claim = await tx.user.updateMany({
                where: { id: userId, lastCheckinDayKey: prevKey },
                data: {
                  lastCheckinDayKey: todayKey,
                  checkinStreakDays: out.nextStreakDays,
                  longestStreakDays: nextLongest,
                  coins: { increment: out.coinsAdd },
                },
              });
              if (claim.count === 0) return; // concurrent post already awarded today — skip
              await tx.coinTransfer.create({
                data: {
                  senderId: userId,
                  recipientId: userId,
                  kind: 'streak_reward',
                  amount: out.coinsAdd,
                  note: `Day ${out.nextStreakDays} streak (${out.multiplier}x)`,
                },
              });
              didAwardStreak = true;
              streakRewardOut = { coinsEarned: out.coinsAdd, streakDays: out.nextStreakDays, multiplier: out.multiplier };
            })()
          : Promise.resolve();

        // Self-view seed: create the row then increment view counters (sequential by data dep).
        // Bots (e.g. Marv) do not count as viewers of their own posts.
        const selfViewOp = viewer.isBot
          ? Promise.resolve()
          : (async () => {
              const seededView = await tx.postView.createMany({
                data: [{ postId: created.id, userId }],
                skipDuplicates: true,
              });
              if (seededView.count > 0) {
                const updatedCounts = await tx.post.update({
                  where: { id: created.id },
                  data: {
                    viewerCount: { increment: 1 },
                    weightedViewCount: { increment: LOGGED_IN_VIEW_WEIGHT },
                  },
                  select: { viewerCount: true, weightedViewCount: true },
                });
                created.viewerCount = updatedCounts.viewerCount;
                created.weightedViewCount = updatedCounts.weightedViewCount;
              }
            })();

        // Parent commentCount increment (only when this is a reply).
        const parentBumpOp = parentId
          ? tx.post.update({
              where: { id: parentId },
              data: { commentCount: { increment: 1 } },
              select: { commentCount: true },
            }).then((parentAfter) => {
              parentCommentCount = typeof parentAfter.commentCount === 'number' ? parentAfter.commentCount : null;
            })
          : Promise.resolve();

        // Quoted-post repost counter bump (only when a local quote was detected).
        const quotedBumpOp = quotedExists
          ? tx.post.update({
              where: { id: quotedExists.id },
              data: { repostCount: { increment: 1 } },
            }).then(() => undefined)
          : Promise.resolve();

        // Hashtag upserts: each tag/variant pair is independent → fire all in parallel.
        const hashtagOps = hashtagTokens.length > 0
          ? Promise.all(
              hashtagTokens.flatMap((tok) => [
                tx.hashtag.upsert({
                  where: { tag: tok.tag },
                  create: { tag: tok.tag, usageCount: 1 },
                  update: { usageCount: { increment: 1 } },
                }),
                tx.hashtagVariant.upsert({
                  where: { tag_variant: { tag: tok.tag, variant: tok.variant } },
                  create: { tag: tok.tag, variant: tok.variant, count: 1 },
                  update: { count: { increment: 1 } },
                }),
              ]),
            )
          : Promise.resolve();

        // All post-create side effects fan out in parallel within the same transaction.
        await Promise.all([parentBumpOp, quotedBumpOp, hashtagOps, streakOp, selfViewOp]);

        return created;
      })
      .catch((e: unknown) => {
        if (kind === 'checkin') {
          // One-per-day uniqueness.
          if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === 'P2002') {
            throw new BadRequestException('Already checked in today.');
          }
        }
        throw e;
      });

    // Versioned read caches: bump after successful create so public reads shift namespaces immediately.
    // Kept on the response path so the very next read in the same client tick sees the new namespace.
    if (post.visibility && post.visibility !== 'onlyMe') {
      await this.cacheInvalidation.bumpForPostWrite({ topics: post.topics ?? [] });
    }

    // Realtime: bump parent commentCount for live subscribers (best-effort, sync emit).
    if (parentId && typeof parentCommentCount === 'number') {
      try {
        this.presenceRealtime.emitPostsLiveUpdated(parentId, {
          postId: parentId,
          version: new Date().toISOString(),
          reason: 'comment_created',
          patch: { commentCount: parentCommentCount },
        });
      } catch {
        // Best-effort
      }
    }

    // Realtime: push full reply DTO to thread subscribers (best-effort, sync emit).
    // `post` already includes user/media/mentions/poll thanks to the create's nested include,
    // so no extra fetch is required.
    if (parentId) {
      try {
        const replyDto = toPostDto(post, this.appConfig.r2()?.publicBaseUrl ?? null, {
          viewerHasBoosted: false,
          includeInternal: false,
        });
        this.presenceRealtime.emitPostsCommentAdded(parentId, {
          parentPostId: parentId,
          comment: replyDto,
        });
      } catch {
        // Best-effort
      }
    }

    // Realtime: push the full DTO to the community-group feed room so members viewing
    // the group see the new post instantly (best-effort). Top-level group posts only —
    // replies surface through the post-room `posts:commentAdded` channel.
    // For non-public posts, emit only to members whose tier meets the visibility requirement.
    const createdGroupId = (post as { communityGroupId?: string | null }).communityGroupId ?? null;
    const createdVisibility = (post as { visibility?: string }).visibility ?? 'public';
    if (!parentId && createdGroupId) {
      try {
        const groupPostDto = toPostDto(post, this.appConfig.r2()?.publicBaseUrl ?? null, {
          viewerHasBoosted: false,
          includeInternal: false,
        });
        if (createdVisibility === 'public') {
          this.presenceRealtime.emitGroupNewPost(createdGroupId, { groupId: createdGroupId, post: groupPostDto });
        } else {
          // Fetch active members who meet the tier requirement for this visibility.
          const tierWhere =
            createdVisibility === 'premiumOnly'
              ? { OR: [{ premium: true }, { premiumPlus: true }] }
              : createdVisibility === 'verifiedOnly'
                ? { OR: [{ verifiedStatus: { not: 'none' } }, { premium: true }, { premiumPlus: true }] }
                : null;
          if (tierWhere) {
            const eligibleMembers = await this.prisma.communityGroupMember.findMany({
              where: { groupId: createdGroupId, status: 'active' },
              select: { userId: true, user: { select: { premium: true, premiumPlus: true, verifiedStatus: true } } },
            });
            const eligible = eligibleMembers
              .filter((m) => {
                if (createdVisibility === 'premiumOnly') return m.user.premium || m.user.premiumPlus;
                return (m.user.verifiedStatus && m.user.verifiedStatus !== 'none') || m.user.premium || m.user.premiumPlus;
              })
              .map((m) => m.userId);
            if (eligible.length > 0) {
              this.presenceRealtime.emitGroupNewPost(
                createdGroupId,
                { groupId: createdGroupId, post: groupPostDto },
                { eligibleMemberUserIds: eligible },
              );
            }
          }
        }
      } catch {
        // Best-effort
      }
    }

    // ─── Defer all notification + follower-fanout work off the response path ─────
    // None of the work below is observed by the caller; running it inline only adds
    // latency for users with deep threads or many followers. We re-throw nothing.
    const quotedInfo = quotedPostInfoRef.current;
    const bodySnippet = body.trim().slice(0, 150);
    const threadPostsForRolesSnapshot = threadPostsForRoles;
    const didAwardStreakSnapshot = didAwardStreak;
    setImmediate(() => {
      void this.runPostCreateSideEffects({
        actorUserId: userId,
        post,
        parentId: parentId ?? null,
        parentAuthorUserId,
        threadPostsForRoles: threadPostsForRolesSnapshot,
        bodyMentionIds,
        bodyMentionSet,
        bodySnippet,
        visibility,
        quotedInfo,
        didAwardStreak: didAwardStreakSnapshot,
        requestedMarvMode,
      });
    });

    // Commenting on a post implies the commenter saw the parent post.
    if (parentId) {
      void this.postViews.markViewed(userId, parentId);
    }

    // Refresh trending score: for comments → parent post; for quote reposts → quoted post; for all posts → the post itself.
    if (parentId) {
      this.ranking.enqueueScoreRefresh(parentId);
    } else if (quotedPostInfoRef.current?.quotedPostId) {
      this.ranking.enqueueScoreRefresh(quotedPostInfoRef.current.quotedPostId);
    }
    this.ranking.enqueueScoreRefresh(post.id);

    const eventName = kind === 'checkin' ? 'checkin_created' : 'post_created';
    this.posthog.capture(userId, eventName, {
      post_id: post.id,
      visibility,
      has_media: (params.media?.length ?? 0) > 0,
      has_poll: Boolean(params.poll),
      is_reply: Boolean(parentId),
    });

    return { post, streakReward: streakRewardOut };
  }

  /**
   * Run notification fan-out, follower scan, feed:newPost realtime emit, and the
   * streak-awarded self-sync emit OFF the request path (invoked via `setImmediate`
   * from `createPost`). Each step is wrapped to never reject — best-effort always.
   */
  private async runPostCreateSideEffects(args: {
    actorUserId: string;
    post: Prisma.PostGetPayload<{
      include: {
        user: { select: typeof USER_LIST_SELECT };
        media: true;
        mentions: { include: { user: { select: typeof MENTION_USER_SELECT } } };
        poll: { include: { options: true } };
      };
    }>;
    parentId: string | null;
    parentAuthorUserId: string | null;
    threadPostsForRoles: Array<{ id: string; parentId: string | null; userId: string; mentions: { userId: string }[] }>;
    bodyMentionIds: string[];
    bodyMentionSet: Set<string>;
    bodySnippet: string;
    visibility: PostVisibility;
    quotedInfo: { quotedAuthorId: string; quotedPostId: string } | null;
    didAwardStreak: boolean;
    requestedMarvMode: 'fast' | 'regular' | 'smart' | null;
  }): Promise<void> {
    const {
      actorUserId,
      post,
      parentId,
      parentAuthorUserId,
      threadPostsForRoles,
      bodyMentionIds,
      bodyMentionSet,
      bodySnippet,
      visibility,
      quotedInfo,
      didAwardStreak,
      requestedMarvMode,
    } = args;
    const userId = actorUserId;
    const postCommunityGroupId = (post as { communityGroupId?: string | null }).communityGroupId ?? null;
    let postGroupJoinPolicy: CommunityGroupJoinPolicy | null | undefined = undefined;
    const checkedGroupNotificationMemberIds = new Set<string>();
    const activeGroupNotificationMemberIds = new Set<string>();
    let groupNotificationMembershipLookupFailed = false;

    const loadPostGroupJoinPolicy = async (): Promise<CommunityGroupJoinPolicy | null> => {
      if (!postCommunityGroupId) return null;
      if (postGroupJoinPolicy !== undefined) return postGroupJoinPolicy;
      try {
        const group = await this.prisma.communityGroup.findUnique({
          where: { id: postCommunityGroupId },
          select: { joinPolicy: true },
        });
        postGroupJoinPolicy = group?.joinPolicy ?? null;
        return postGroupJoinPolicy;
      } catch (err) {
        this.logger.warn(
          `[notifications] Failed to evaluate group policy for post notifications: ${err instanceof Error ? err.message : String(err)}`,
        );
        postGroupJoinPolicy = null;
        return null;
      }
    };

    const loadActiveGroupNotificationMembers = async (recipientUserIds: string[]): Promise<void> => {
      if (!postCommunityGroupId || groupNotificationMembershipLookupFailed) return;
      const missingIds = [...new Set(recipientUserIds.filter((id) => id && !checkedGroupNotificationMemberIds.has(id)))];
      if (missingIds.length === 0) return;

      try {
        const members = await this.prisma.communityGroupMember.findMany({
          where: {
            groupId: postCommunityGroupId,
            userId: { in: missingIds },
            status: 'active',
          },
          select: { userId: true },
        });
        for (const uid of missingIds) checkedGroupNotificationMemberIds.add(uid);
        for (const member of members) activeGroupNotificationMemberIds.add(member.userId);
      } catch (err) {
        this.logger.warn(
          `[notifications] Failed to evaluate group membership for post notifications: ${err instanceof Error ? err.message : String(err)}`,
        );
        groupNotificationMembershipLookupFailed = true;
      }
    };

    const canNotifyForGroupPost = async (
      recipientUserId: string | null | undefined,
      opts?: { allowPublicOpenGroupMention?: boolean },
    ): Promise<boolean> => {
      if (!postCommunityGroupId) return true;
      const uid = (recipientUserId ?? '').trim();
      if (!uid) return false;

      if (opts?.allowPublicOpenGroupMention && visibility === 'public') {
        const joinPolicy = await loadPostGroupJoinPolicy();
        if (joinPolicy === 'open') return true;
      }

      await loadActiveGroupNotificationMembers([uid]);
      if (groupNotificationMembershipLookupFailed) return false;
      return activeGroupNotificationMemberIds.has(uid);
    };

    try {
      // Quote repost notification: notify the quoted post's author (skip self-quotes).
      if (
        quotedInfo &&
        quotedInfo.quotedAuthorId !== userId &&
        await canNotifyForGroupPost(quotedInfo.quotedAuthorId)
      ) {
        this.notifications
          .upsertRepostNotification({
            recipientUserId: quotedInfo.quotedAuthorId,
            actorUserId: userId,
            subjectPostId: quotedInfo.quotedPostId,
            actorPostId: post.id,
            title: 'quoted your post',
          })
          .catch((err) => {
            this.logger.warn(`[notifications] Failed to create quote repost notification: ${err instanceof Error ? err.message : String(err)}`);
          });
      }

      // Notifications: parent author + thread participants get "comment" notifications.
      // Only explicit @mentions in body get "mention" notifications (and override "comment" for that user).
      let threadRoles: Map<string, keyof typeof PostsMutationService.REPLY_TITLE> | null = null;
      if (parentId && parentAuthorUserId !== userId) {
        // In-memory walk over the thread tree we already fetched in createPost.
        threadRoles = this.computeThreadRolesFromPosts(threadPostsForRoles, parentId);
        const parentRole = threadRoles.get(parentAuthorUserId ?? '');
        const parentTitle =
          parentRole === 'reply_author'
            ? PostsMutationService.REPLY_TITLE.reply_author
            : parentRole === 'root_author'
              ? PostsMutationService.REPLY_TITLE.root_author
              : PostsMutationService.REPLY_TITLE.reply_author;

        if (
          parentAuthorUserId &&
          !bodyMentionSet.has(parentAuthorUserId) &&
          await canNotifyForGroupPost(parentAuthorUserId)
        ) {
          this.notifications
            .create({
              recipientUserId: parentAuthorUserId,
              kind: 'comment',
              actorUserId: userId,
              actorPostId: post.id,
              subjectPostId: parentId,
              title: parentTitle,
              body: bodySnippet || undefined,
            })
            .catch((err) => {
              this.logger.warn(`[notifications] Failed to create comment notification: ${err instanceof Error ? err.message : String(err)}`);
            });
        }

        for (const [uid, role] of threadRoles) {
          if (uid === userId || uid === parentAuthorUserId || bodyMentionSet.has(uid)) continue;
          if (!await canNotifyForGroupPost(uid)) continue;
          const title = PostsMutationService.REPLY_TITLE[role];
          this.notifications
            .create({
              recipientUserId: uid,
              kind: 'comment',
              actorUserId: userId,
              actorPostId: post.id,
              subjectPostId: parentId,
              title,
              body: bodySnippet || undefined,
            })
            .catch((err) => {
              this.logger.warn(`[notifications] Failed to create thread reply notification: ${err instanceof Error ? err.message : String(err)}`);
            });
        }
      }

      // Explicit @mentions in body: one notification each (priority over comment notifications).
      // Group posts are members-only for notifications, except public posts in OPEN
      // groups where an explicit mention is allowed to reach a non-member.
      const canMentionNonMembersInPublicOpenGroup =
        Boolean(postCommunityGroupId) &&
        bodyMentionIds.length > 0 &&
        visibility === 'public' &&
        await loadPostGroupJoinPolicy() === 'open';
      if (postCommunityGroupId && bodyMentionIds.length > 0 && !canMentionNonMembersInPublicOpenGroup) {
        await loadActiveGroupNotificationMembers(bodyMentionIds.filter((uid) => uid !== userId));
      }

      for (const uid of bodyMentionIds) {
        if (uid === userId) continue;
        if (!canMentionNonMembersInPublicOpenGroup && !await canNotifyForGroupPost(uid)) continue;
        let mentionTitle: string;
        if (!parentId) {
          mentionTitle = 'mentioned you in a post';
        } else if (uid === parentAuthorUserId) {
          mentionTitle = 'mentioned you in a reply to your post';
        } else {
          mentionTitle = 'mentioned you in a reply to a post';
        }
        this.notifications
          .create({
            recipientUserId: uid,
            kind: 'mention',
            actorUserId: userId,
            actorPostId: post.id,
            subjectPostId: post.id,
            title: mentionTitle,
            body: bodySnippet || undefined,
          })
          .catch((err) => {
            this.logger.warn(`[notifications] Failed to create mention notification: ${err instanceof Error ? err.message : String(err)}`);
          });
      }

      // Badge-only notifications for all active group members when a top-level post is created in a group.
      if (!parentId && postCommunityGroupId) {
        try {
          const groupMembers = await this.prisma.communityGroupMember.findMany({
            where: { groupId: postCommunityGroupId, status: 'active', userId: { not: userId } },
            select: { userId: true },
          });
          const memberIds = groupMembers.map((m) => m.userId);
          if (memberIds.length > 0) {
            this.notifications.createGroupPostBadgeNotifications({
              actorUserId: userId,
              postId: post.id,
              groupId: postCommunityGroupId,
              recipientUserIds: memberIds,
            }).catch((err) => {
              this.logger.warn(
                `[notifications] Failed to create group-post badge notifications: ${err instanceof Error ? err.message : String(err)}`,
              );
            });
          }
        } catch (err) {
          this.logger.warn(
            `[notifications] Failed to fan out group-post badge notifications: ${err instanceof Error ? err.message : String(err)}`,
          );
        }
      }

      // Follower notifications + feed:newPost realtime emit (top-level only).
      // Group posts are excluded from home feeds; the Groups badge (community_group_post
      // notification row) is the only signal for new group activity on followers' home surfaces.
      const feedFollowerIds: string[] = [];
      if (!postCommunityGroupId && visibility !== 'onlyMe') {
        try {
          const follows = await this.prisma.follow.findMany({
            where: { followingId: userId },
            select: {
              followerId: true,
              follower: { select: { verifiedStatus: true, premium: true, premiumPlus: true } },
            },
          });

          for (const f of follows) {
            const recipientUserId = f.followerId;
            if (!recipientUserId || recipientUserId === userId) continue;
            if (bodyMentionSet.has(recipientUserId)) continue;
            if (parentId && (recipientUserId === parentAuthorUserId || threadRoles?.has(recipientUserId))) continue;
            if (!await canNotifyForGroupPost(recipientUserId)) continue;

            if (visibility === 'verifiedOnly') {
              const vs = f.follower?.verifiedStatus ?? 'none';
              if (!vs || vs === 'none') continue;
            }
            if (visibility === 'premiumOnly') {
              const isPremium = Boolean(f.follower?.premium || f.follower?.premiumPlus);
              if (!isPremium) continue;
            }

            this.notifications
              .create({
                recipientUserId,
                kind: 'followed_post',
                actorUserId: userId,
                actorPostId: post.id,
                subjectPostId: post.id,
                subjectUserId: userId,
                body: bodySnippet || undefined,
              })
              .catch((err) => {
                this.logger.warn(
                  `[notifications] Failed to create followed-post notification: ${err instanceof Error ? err.message : String(err)}`,
                );
              });

            if (!parentId) feedFollowerIds.push(recipientUserId);
          }
        } catch (err) {
          this.logger.warn(
            `[notifications] Failed to query followers for followed-post notifications: ${err instanceof Error ? err.message : String(err)}`,
          );
        }
      }

      // Realtime: push new top-level post to home feeds of eligible followers (best-effort).
      if (!parentId && feedFollowerIds.length > 0) {
        try {
          const feedPostDto = toPostDto(post, this.appConfig.r2()?.publicBaseUrl ?? null, {
            viewerHasBoosted: false,
            includeInternal: false,
          });
          this.presenceRealtime.emitFeedNewPost(feedFollowerIds, { post: feedPostDto });
        } catch {
          // Best-effort
        }
      }

      // Check-in social proof: tell the actor's circle (followers + crew members) that
      // someone they care about answered today's question. The receiver UI uses this to
      // increment the daily total and prepend a face on the home hero, no refetch needed.
      // We emit only for non-private check-ins; onlyMe should never leak presence.
      const postKind = (post as { kind?: string | null }).kind ?? null;
      const checkinDayKey = (post as { checkinDayKey?: string | null }).checkinDayKey ?? null;
      if (postKind === 'checkin' && checkinDayKey && visibility !== 'onlyMe') {
        try {
          const [allFollowers, crewMembers, totalToday, actor] = await Promise.all([
            this.prisma.follow.findMany({
              where: { followingId: userId },
              select: { followerId: true },
            }),
            this.prisma.crewMember.findMany({
              where: {
                crew: { members: { some: { userId } } },
                userId: { not: userId },
              },
              select: { userId: true },
            }),
            this.prisma.post.count({
              where: {
                kind: 'checkin',
                checkinDayKey,
                deletedAt: null,
                visibility: { not: 'onlyMe' },
              },
            }),
            this.prisma.user.findUnique({
              where: { id: userId },
              select: {
                id: true,
                username: true,
                name: true,
                avatarKey: true,
                avatarUpdatedAt: true,
              },
            }),
          ]);

          if (actor) {
            const recipientIds = new Set<string>();
            for (const f of allFollowers) {
              if (f.followerId && f.followerId !== userId) recipientIds.add(f.followerId);
            }
            for (const m of crewMembers) {
              if (m.userId && m.userId !== userId) recipientIds.add(m.userId);
            }

            if (recipientIds.size > 0) {
              const avatarUrl = publicAssetUrl({
                publicBaseUrl: this.appConfig.r2()?.publicBaseUrl ?? null,
                key: actor.avatarKey,
                updatedAt: actor.avatarUpdatedAt,
              });
              this.presenceRealtime.emitCheckinAnsweredToday(recipientIds, {
                dayKey: checkinDayKey,
                totalToday,
                answerer: {
                  id: actor.id,
                  username: actor.username,
                  displayName: (actor.name ?? actor.username ?? '').trim() || null,
                  avatarUrl,
                },
              });
            }
          }
        } catch (err) {
          this.logger.warn(
            `[checkin] Failed to fan out checkin:answeredToday: ${err instanceof Error ? err.message : String(err)}`,
          );
        }
      }

      // If we awarded streak/coins today, sync self snapshot across tabs/devices (best-effort).
      if (didAwardStreak) {
        try {
          const u = await this.prisma.user.findUnique({ where: { id: userId } });
          if (u) {
            this.presenceRealtime.emitUsersMeUpdated(userId, {
              user: toUserDto(u, this.appConfig.r2()?.publicBaseUrl ?? null),
              reason: 'streak_awarded',
            });
          }
        } catch {
          // Best-effort
        }
      }

      // ─── Marv: detect @marv in the post body and enqueue an async reply job ────
      // Fully decoupled — PostsService doesn't know about MarvinModule. Mention detection
      // runs against the configured Marv username from env so the queueing surface stays
      // dumb and the processor handles all gating (premium, credits, rate limits, AI call).
      //
      // Two triggers:
      //   1. Explicit — the body contains @marv (the configured username).
      //   2. Implicit — the post is a direct reply to a post authored by Marv. The
      //      user doesn't need to type @marv; replying to Marv directly implies the mention.
      try {
        const marvCfg = this.appConfig.marvBot();
        if (!marvCfg.enabled) {
          this.logger.log(`[marv] mention-detect post=${post.id} skip reason=marv_disabled`);
        } else {
          const marvUsernameLower = marvCfg.username.trim().toLowerCase();
          const bodyMentions = this.parseMentionsFromBody(post.body ?? '').map((u) =>
            u.trim().toLowerCase(),
          );
          const bodyMentionUsernamesLower = new Set(bodyMentions);
          const resolvedMarvId = this.marvIdentity.cachedMarvUserId() ?? marvCfg.userId ?? null;
          const actorIsMarv = Boolean(resolvedMarvId && actorUserId === resolvedMarvId);
          const mentionsMarv = bodyMentionUsernamesLower.has(marvUsernameLower);

          // Check for implied mention: direct reply to one of Marv's posts.
          let impliedMention = false;
          const parentPostId = (post as { parentId?: string | null }).parentId ?? null;
          if (!mentionsMarv && !actorIsMarv && parentPostId && resolvedMarvId) {
            const parentAuthor = await this.prisma.post.findFirst({
              where: { id: parentPostId, deletedAt: null },
              select: { userId: true },
            });
            impliedMention = parentAuthor?.userId === resolvedMarvId;
            if (impliedMention) {
              this.logger.log(
                `[marv] mention-detect post=${post.id} implied-mention via direct reply to parent=${parentPostId} (authored by marv)`,
              );
            }
          }

          if (!mentionsMarv && !impliedMention) {
            this.logger.log(
              `[marv] mention-detect post=${post.id} skip reason=no_mention mentions=[${bodyMentions.join(',') || '-'}] expected=@${marvUsernameLower}`,
            );
          } else if (actorIsMarv) {
            this.logger.log(`[marv] mention-detect post=${post.id} skip reason=actor_is_marv`);
          } else {
            const rootPostId = (post as { rootId?: string | null }).rootId ?? post.id;
            const postGroupId = (post as { communityGroupId?: string | null }).communityGroupId ?? null;

            // If this post is inside a community group, check whether Marv is an active member.
            // If he isn't, send a one-time informational notification instead of a reply.
            if (postGroupId) {
              const marvId = resolvedMarvId ?? await this.marvIdentity.getMarvUserId();
              if (marvId) {
                const marvMembership = await this.prisma.communityGroupMember.findUnique({
                  where: { groupId_userId: { groupId: postGroupId, userId: marvId } },
                  select: { status: true },
                });
                const marvIsGroupMember = marvMembership?.status === 'active';

                if (!marvIsGroupMember) {
                  this.logger.log(
                    `[marv] mention-detect post=${post.id} skip reason=marv_not_in_group groupId=${postGroupId}`,
                  );
                  void this.notifications.upsertMarvNotInGroupNotification({
                    recipientUserId: actorUserId,
                    marvUserId: marvId,
                    postId: post.id,
                    groupId: postGroupId,
                  });
                  return;
                }
              }
            }

            this.logger.log(
              `[marv] mention-detect post=${post.id} HIT enqueueing root=${rootPostId} actor=${actorUserId} requestedMode=${requestedMarvMode ?? 'null'}`,
            );
            await this.jobs
              .enqueue(
                JOBS.marvinReplyPublic,
                {
                  postId: post.id,
                  rootPostId,
                  requestingUserId: actorUserId,
                  requestedMode: requestedMarvMode,
                  bodySnippet,
                  visibility,
                },
                {
                  // Stable job id per (post, requester) so duplicate side-effect runs
                  // (which shouldn't happen, but guard cheaply) don't enqueue twice.
                  jobId: `marv-public-${post.id}`,
                  removeOnComplete: true,
                  removeOnFail: false,
                  attempts: 3,
                  backoff: { type: 'exponential' as const, delay: 5000 },
                },
              )
              .then(() => {
                this.logger.log(`[marv] mention-detect post=${post.id} enqueued ok`);
              })
              .catch((err) => {
                this.logger.warn(
                  `[marv] Failed to enqueue public reply job for post=${post.id}: ${
                    err instanceof Error ? err.message : String(err)
                  }`,
                );
              });
          }
        }
      } catch (err) {
        this.logger.warn(
          `[marv] mention-detection during side-effects failed: ${err instanceof Error ? err.message : String(err)}`,
        );
      }
    } catch (err) {
      this.logger.warn(
        `[posts] Deferred post-create side effects failed: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }

  /**
   * Attempt to extract a local post ID from a URL that looks like
   * `https://menofhunger.com/p/<id>` (or any configured frontend origin).
   * Returns null if the URL does not match.
   */
  private tryExtractLocalPostIdFromUrl(raw: string): string | null {
    const s = (raw ?? '').trim();
    if (!s) return null;
    try {
      const u = new URL(s);
      if (u.protocol !== 'http:' && u.protocol !== 'https:') return null;
      const parts = u.pathname.split('/').filter(Boolean);
      if (parts.length !== 2 || parts[0] !== 'p') return null;
      const id = (parts[1] ?? '').trim();
      if (!id) return null;
      // Only accept our own known origins to prevent abuse.
      const allowed = new Set<string>();
      allowed.add('menofhunger.com');
      allowed.add('www.menofhunger.com');
      const frontendBase = this.appConfig.frontendBaseUrl()?.trim() ?? '';
      if (frontendBase) {
        try { allowed.add(new URL(frontendBase).hostname.toLowerCase()); } catch { /* ignore */ }
      }
      const host = u.hostname.toLowerCase();
      if (!allowed.has(host) && !host.endsWith('.menofhunger.com')) return null;
      return id;
    } catch {
      return null;
    }
  }

  /** Ascending exclusivity rank matching the shared contract: public < verifiedOnly < premiumOnly < onlyMe. */
  private visibilityRank(vis: string): number {
    switch (vis) {
      case 'public': return 0;
      case 'verifiedOnly': return 1;
      case 'premiumOnly': return 2;
      case 'onlyMe': return 3;
      default: return 0;
    }
  }

  /**
   * Scan body text for a local post link and return its ID (or null).
   * Used to populate quotedPostId on new posts.
   */
  private extractQuotedPostIdFromBody(body: string): string | null {
    const urlRegex = /https?:\/\/[^\s<>"']+/g;
    const matches = body.match(urlRegex) ?? [];
    // Take the last matching local post link (same as frontend behaviour).
    for (let i = matches.length - 1; i >= 0; i--) {
      const id = this.tryExtractLocalPostIdFromUrl(matches[i]!);
      if (id) return id;
    }
    return null;
  }
}
