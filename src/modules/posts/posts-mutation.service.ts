import { BadRequestException, ForbiddenException, HttpException, HttpStatus, Injectable, Logger, NotFoundException } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import type { PostVisibility } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
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
import { toPostDto } from '../../common/dto/post.dto';
import { LOGGED_IN_VIEW_WEIGHT } from '../views/view-tracking.utils';
import { PostViewsService } from '../post-views/post-views.service';
import { PosthogService } from '../../common/posthog/posthog.service';
import { notDeletedWhere } from './posts-query-builders';
import {
  excludeMarvUserId,
  resolveMentionUsernames as resolveMentionUsernamesQuery,
  resolveMentionUsernamesMap as resolveMentionUsernamesMapQuery,
} from './posts-mentions.helpers';
import { PostsRankingService } from './posts-ranking.service';
import { PostsViewerEnrichmentService } from './posts-viewer-enrichment.service';
import { SiteConfigService } from '../site-config/site-config.service';
import { SideEffectsService } from '../side-effects/side-effects.service';
import { PostsTopicsClassifyService } from './posts-topics-classify.service';

/**
 * Post write paths: create (with the full side-effect pipeline), update,
 * delete, publish-from-onlyMe. Reads stay in PostsFeedQueryService;
 * engagement mutations (boost/repost) live in PostsEngagementService.
 */
@Injectable()
export class PostsMutationService {
  private readonly logger = new Logger(PostsMutationService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly presenceRealtime: PresenceRealtimeService,
    private readonly cacheInvalidation: CacheInvalidationService,
    private readonly appConfig: AppConfigService,
    private readonly postViews: PostViewsService,
    private readonly posthog: PosthogService,
    private readonly viewerContextService: ViewerContextService,
    private readonly enrichment: PostsViewerEnrichmentService,
    private readonly ranking: PostsRankingService,
    private readonly ticker: TickerService,
    private readonly siteConfig: SiteConfigService,
    private readonly sideEffects: SideEffectsService,
    private readonly topicsClassify: PostsTopicsClassifyService,
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

      // Decrement repostCount (and quoteCount for quotes) on the target post when a repost/quote repost is deleted.
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
          data: { repostCount: { decrement: 1 }, quoteCount: { decrement: 1 } },
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

    // Notification cleanup (rows referencing this post as subject or actorPost) runs on the
    // side-effects queue: the caller only needs to know the post is gone, and a stale bell row
    // for a deleted post is a self-healing problem the retry handles.
    this.sideEffects.dispatch('post.deleted', { postId: id }, { jobId: `post-deleted-${id}` });
    void this.cacheInvalidation.bumpForPostWrite({ topics: postTopics });

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

    // Detect whether the quoted post link changed so we can adjust repostCount.
    const prevQuotedPostId: string | null = (post as any).quotedPostId ?? null;
    const detectedQuotedId = this.extractQuotedPostIdFromBody(nextBody);
    const nextQuotedExists = detectedQuotedId
      ? await this.prisma.post.findFirst({
          where: { id: detectedQuotedId, deletedAt: null },
          select: { id: true, visibility: true, communityGroupId: true },
        })
      : null;
    const nextQuotedPostId: string | null = nextQuotedExists?.id ?? null;
    const quoteLinkChanged = prevQuotedPostId !== nextQuotedPostId;

    // Quote floor: quoting post visibility must not be more open than the quoted post's.
    // Same rule as create — applied on edit so a body change can't reintroduce the leak.
    if (nextQuotedExists) {
      const sameGroup = post.communityGroupId && nextQuotedExists.communityGroupId === post.communityGroupId;
      if (!sameGroup && this.visibilityRank(post.visibility) < this.visibilityRank(nextQuotedExists.visibility)) {
        throw new ForbiddenException("A quote can't be more public than the post it quotes.");
      }
    }

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
          topicsClassifiedAt: topics.length > 0 ? undefined : null,
          hashtags,
          hashtagCasings,
          cashtags,
          editedAt: new Date(),
          editCount: { increment: 1 },
          // Update the stored quotedPostId to reflect the new body's link.
          ...(quoteLinkChanged ? { quotedPostId: nextQuotedPostId } : {}),
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

      // Adjust repostCount and quoteCount on old and new quoted targets (in-transaction to prevent drift).
      if (quoteLinkChanged) {
        if (prevQuotedPostId) {
          // Quote link removed or swapped away — decrement the old target.
          await tx.post.updateMany({
            where: { id: prevQuotedPostId },
            data: { repostCount: { decrement: 1 }, quoteCount: { decrement: 1 } },
          });
        }
        if (nextQuotedPostId) {
          // Quote link added or swapped in — increment the new target.
          await tx.post.update({
            where: { id: nextQuotedPostId },
            data: { repostCount: { increment: 1 }, quoteCount: { increment: 1 } },
          });
        }
      }

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
    void this.topicsClassify.enqueueIfNeeded(id);

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

    // If the quoted link changed, dispatch a side effect to reconcile notifications and
    // emit liveUpdated on both old and new quoted targets.
    if (quoteLinkChanged) {
      this.sideEffects.dispatch('post.quote.changed', {
        postId: id,
        actorUserId: userId,
        prevQuotedPostId,
        nextQuotedPostId,
      });
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
    kind?: 'regular' | 'checkin' | 'status';
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
    const kind = (params.kind ?? 'regular') as 'regular' | 'checkin' | 'status';
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

    if (kind === 'status') {
      if (requestedCommunityGroupId) {
        throw new BadRequestException('Status posts cannot be posted inside a community group.');
      }
      if (parentId) throw new BadRequestException('Status posts must be top-level.');
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
      const cfg = await this.siteConfig.get(); // in-memory cached; near-free
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

    // Body-only mention ids used to be derived here for notification priority; that now happens
    // in PostsSideEffectsHandler, which re-parses the persisted body. Only the full resolved set
    // (for the PostMention rows) is still needed on the request path.
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

    // All mention IDs for PostMention records (include self so @yourname renders as a link).
    // Marv is not inherited from the thread — only an explicit @marv (in body or client list)
    // should create a mention row for him.
    const marvCfg = this.appConfig.marvBot();
    const marvId = marvCfg.userId ?? mentionUsernameToId.get(marvCfg.username.trim().toLowerCase()) ?? null;
    const mentionUserIds = [
      ...new Set([...excludeMarvUserId(threadParticipantIds, marvId), ...resolvedFromUsernames]),
    ];

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
              select: { id: true, userId: true, visibility: true, communityGroupId: true },
            })
          : null;
        const quotedPostIdToSet = quotedExists ? quotedExists.id : null;

        // Quote floor: the quoting post's effective visibility must not be more open than
        // the quoted post's visibility.  Applied universally — replies, group posts, and
        // check-ins are no longer bypassed.
        //
        // `visibility` is already the effective value: parentPost.visibility for replies,
        // 'public' for group posts, requestedVisibility otherwise.
        //
        // Exception: a group post quoting a post that lives in the same group is allowed
        // because every member of the group has read access regardless of their tier.
        if (quotedExists) {
          const sameGroup =
            resolvedCommunityGroupId && quotedExists.communityGroupId === resolvedCommunityGroupId;
          if (!sameGroup && this.visibilityRank(visibility) < this.visibilityRank(quotedExists.visibility)) {
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
                    totalViewCount: { increment: 1 },
                    weightedViewCount: { increment: LOGGED_IN_VIEW_WEIGHT },
                  },
                  select: { viewerCount: true, totalViewCount: true, weightedViewCount: true },
                });
                created.viewerCount = updatedCounts.viewerCount;
                created.totalViewCount = updatedCounts.totalViewCount;
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

        // Quoted-post repost + quoteCount counter bump (only when a local quote was detected).
        const quotedBumpOp = quotedExists
          ? tx.post.update({
              where: { id: quotedExists.id },
              data: { repostCount: { increment: 1 }, quoteCount: { increment: 1 } },
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

    // New content is delivered over realtime; feed snapshots expire within 30s.
    // Keep search/topic invalidation, without flushing every viewer's feed.
    // Edits and deletions still invalidate immediately above.
    if (post.visibility && post.visibility !== 'onlyMe') {
      void this.cacheInvalidation.bumpForPostWrite({ topics: post.topics ?? [], invalidateFeed: false });
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

    // Realtime: push the full DTO to the community-group feed room so members viewing the group
    // see the new post instantly. Top-level group posts only — replies surface through the
    // post-room `posts:commentAdded` channel.
    //
    // Only the public case stays here: it needs no extra query, and making group content appear
    // is the same class of emit as `posts:commentAdded`. Non-public posts need a full member+tier
    // scan to build the audience, so that branch runs in the side-effects handler instead.
    const createdGroupId = (post as { communityGroupId?: string | null }).communityGroupId ?? null;
    const createdVisibility = (post as { visibility?: string }).visibility ?? 'public';
    if (!parentId && createdGroupId && createdVisibility === 'public') {
      try {
        const groupPostDto = toPostDto(post, this.appConfig.r2()?.publicBaseUrl ?? null, {
          viewerHasBoosted: false,
          includeInternal: false,
        });
        this.presenceRealtime.emitGroupNewPost(createdGroupId, { groupId: createdGroupId, post: groupPostDto });
      } catch {
        // Best-effort
      }
    }

    // ─── Hand all notification + fan-out work to the side-effects queue ──────────
    // None of it is observed by the caller, and running it in this process would both add
    // latency here and steal DB/CPU from concurrent requests. See PostsSideEffectsHandler.
    this.sideEffects.dispatch('post.created', {
      postId: post.id,
      actorUserId: userId,
      didAwardStreak,
      requestedMarvMode,
    }, { jobId: `post-created-${post.id}` });

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
