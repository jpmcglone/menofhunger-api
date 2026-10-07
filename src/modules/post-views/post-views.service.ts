import { Injectable, Logger, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { CacheService } from '../redis/cache.service';
import { RedisService } from '../redis/redis.service';
import { PresenceRealtimeService } from '../presence/presence-realtime.service';
import { CacheInvalidationService } from '../redis/cache-invalidation.service';
import { PosthogService } from '../../common/posthog/posthog.service';
import { NotificationsService } from '../notifications/notifications.service';
import type { PostViewAckDto } from '../../common/dto/view-ack.dto';
import {
  ANON_VIEW_WEIGHT,
  LOGGED_IN_VIEW_WEIGHT,
  VIEW_ROOM_EMIT_THROTTLE_MS,
  cutoffForAnonRecount,
  cutoffForLastSeenRefresh,
  cutoffForTotalViewRecount,
  sanitizeAnonViewerId,
} from '../views/view-tracking.utils';

import { PostsReadService } from '../posts-read/posts-read.service';
import { PostsWriteService } from '../posts-read/posts-write.service';
const BREAKDOWN_TTL_SECONDS = 60;
const BATCH_MAX = 50;

function viewerCanAccessVisibility(
  visibility: string,
  viewer: { verifiedStatus: string; premium: boolean; premiumPlus: boolean } | null,
): boolean {
  if (visibility === 'public') return true;
  if (!viewer) return false;
  const isPremium = viewer.premium || viewer.premiumPlus;
  const isVerified = viewer.verifiedStatus !== 'none' || isPremium;
  if (visibility === 'verifiedOnly') return isVerified;
  if (visibility === 'premiumOnly') return isPremium;
  return false;
}

function breakdownCacheKey(postId: string): string {
  return `cache:post-view-breakdown:${postId}`;
}

function normalizeViewSource(source: string | null | undefined): string | null {
  const value = (source ?? '').toString().trim().slice(0, 80);
  return value || null;
}

export type PostViewBreakdown = {
  premium: number;
  verified: number;
  unverified: number;
  guest: number;
  /** Unique people — keep this name for shipped iOS. */
  total: number;
  totalViewCount: number;
  premiumTotal: number;
  verifiedTotal: number;
  unverifiedTotal: number;
  guestTotal: number;
};

@Injectable()
export class PostViewsService {
  private readonly logger = new Logger(PostViewsService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly cache: CacheService,
    private readonly redis: RedisService,
    private readonly cacheInvalidation: CacheInvalidationService,
    private readonly presenceRealtime: PresenceRealtimeService,
    private readonly posthog: PosthogService,
    private readonly notifications: NotificationsService,
    private readonly postsRead: PostsReadService,
    private readonly postsWrite: PostsWriteService,
  ) {}

  /**
   * Record that a user viewed a post.
   * Unique viewerCount stays 1 per person. Total increments on first look and
   * again when a later report arrives after lastImpressionAt is older than 30s
   * (leave-and-return, not a sitting heartbeat).
   */
  async markViewed(
    userId: string | null | undefined,
    postId: string,
    anonViewerId?: string | null,
    source?: string | null,
    opts?: { skipMarkRead?: boolean },
  ): Promise<PostViewAckDto | null> {
    const uid = (userId ?? '').trim();
    const pid = (postId ?? '').trim();
    const anonId = sanitizeAnonViewerId(anonViewerId);
    if (!pid || (!uid && !anonId)) return null;

    try {
      const post = await this.postsRead.read.findFirst({
        where: { id: pid, deletedAt: null },
        select: { id: true, visibility: true, userId: true },
      });
      if (!post) return null;

      const viewer = uid
        ? await this.prisma.user.findFirst({
            where: { id: uid },
            select: { isBot: true, verifiedStatus: true, premium: true, premiumPlus: true },
          })
        : null;
      if (viewer?.isBot) return null;

      if (uid && post.userId !== uid && !viewerCanAccessVisibility(post.visibility, viewer)) return null;
      if (!uid && post.visibility !== 'public') return null;

      if (uid && anonId) {
        await this.prisma.viewerIdentity.upsert({
          where: { anonId },
          create: { anonId, userId: uid },
          update: { userId: uid },
        });
      }

      if (uid) {
        const ack = await this.markAuthenticatedView(uid, pid, anonId, source, opts);
        if (ack) await this.recordOpen(uid, pid, null, source);
        return ack;
      }
      const ack = await this.markAnonView(pid, anonId as string);
      if (ack) await this.recordOpen(null, pid, anonId, source);
      return ack;
    } catch (err) {
      this.logger.warn(`markViewed failed for postId=${pid} userId=${uid}: ${String(err)}`);
      return null;
    }
  }

  private async markAuthenticatedView(
    uid: string,
    pid: string,
    anonId: string | null,
    source?: string | null,
    opts?: { skipMarkRead?: boolean },
  ): Promise<PostViewAckDto | null> {
    const now = new Date();
    const lastSource = normalizeViewSource(source);
    const result = await this.prisma.$transaction(async (tx) => {
      const created = await tx.postView.createMany({
        data: [{
          postId: pid,
          userId: uid,
          lastSeenAt: now,
          seenCount: 1,
          impressionCount: 1,
          lastImpressionAt: now,
          lastSource,
        }],
        skipDuplicates: true,
      });
      const anonOpen = anonId ? await tx.postAnonView.findUnique({
        where: { postId_anonId: { postId: pid, anonId } }, select: { openCount: true, lastOpenedAt: true },
      }) : null;
      const consumedAnonCount = anonId
        ? (await tx.postAnonView.deleteMany({ where: { postId: pid, anonId } })).count
        : 0;
      if (consumedAnonCount && anonOpen) await this.mergeOpenHistory(tx, uid, pid, anonOpen);


      let viewerIncrementLocal = 0;
      let weightedIncrementLocal = 0;
      let totalIncrementLocal = 0;
      let lastSeenRefreshed = created.count > 0;
      if (created.count > 0) {
        viewerIncrementLocal = consumedAnonCount > 0 ? 0 : 1;
        weightedIncrementLocal = consumedAnonCount > 0 ? 0.5 : LOGGED_IN_VIEW_WEIGHT;
        totalIncrementLocal = 1;
      } else {
        const refreshed = await tx.postView.updateMany({
          where: {
            postId: pid,
            userId: uid,
            lastSeenAt: { lt: cutoffForLastSeenRefresh(now) },
          },
          data: {
            lastSeenAt: now,
            seenCount: { increment: 1 },
            lastSource,
          },
        });
        lastSeenRefreshed = refreshed.count > 0;

        const impressed = await tx.postView.updateMany({
          where: {
            postId: pid,
            userId: uid,
            lastImpressionAt: { lt: cutoffForTotalViewRecount(now) },
          },
          data: {
            lastImpressionAt: now,
            impressionCount: { increment: 1 },
          },
        });
        if (impressed.count > 0) totalIncrementLocal = 1;
      }

      if (viewerIncrementLocal !== 0 || weightedIncrementLocal !== 0 || totalIncrementLocal !== 0) {
        const updated = await tx.post.update({
          where: { id: pid },
          data: {
            ...(viewerIncrementLocal !== 0 ? { viewerCount: { increment: viewerIncrementLocal } } : {}),
            ...(weightedIncrementLocal !== 0 ? { weightedViewCount: { increment: weightedIncrementLocal } } : {}),
            ...(totalIncrementLocal !== 0 ? { totalViewCount: { increment: totalIncrementLocal } } : {}),
          },
          select: { viewerCount: true, totalViewCount: true },
        });
        return {
          createdCount: created.count,
          viewerIncrementLocal,
          weightedIncrementLocal,
          totalIncrementLocal,
          lastSeenRefreshed,
          viewerCount: updated.viewerCount,
          totalViewCount: updated.totalViewCount,
        };
      }

      const unchanged = await tx.post.findUnique({
        where: { id: pid },
        select: { viewerCount: true, totalViewCount: true },
      });
      return {
        createdCount: created.count,
        viewerIncrementLocal,
        weightedIncrementLocal,
        totalIncrementLocal,
        lastSeenRefreshed,
        viewerCount: unchanged?.viewerCount ?? 0,
        totalViewCount: unchanged?.totalViewCount ?? 0,
      };
    });

    if (result.createdCount > 0) {
      this.posthog.capture(uid, 'post_viewed', {
        post_id: pid,
        source: lastSource ?? 'unknown',
        viewer_type: 'user',
      });
    }
    if (result.lastSeenRefreshed) {
      await this.cacheInvalidation.bumpForYouUser(uid).catch(() => undefined);
    }

    const uniqueCounted = result.viewerIncrementLocal !== 0;
    const totalCounted = result.totalIncrementLocal !== 0;
    if (uniqueCounted || totalCounted) {
      void this.redis.del(breakdownCacheKey(pid)).catch(() => undefined);
      await this.emitViewCounts(pid, {
        viewerCount: result.viewerCount,
        totalViewCount: result.totalViewCount,
        uniqueCounted,
        totalCounted,
        actorUserId: uid,
      });
    }
    if (!opts?.skipMarkRead && (source !== 'feed_scroll' || await this.postsRead.read.findFirst({
      where: { id: pid, kind: { not: 'board' } }, select: { id: true },
    }))) {
      await this.notifications.markReadBySubject(uid, { postId: pid });
    }
    return {
      id: pid,
      uniqueCounted,
      totalCounted,
      viewerCount: result.viewerCount,
      totalViewCount: result.totalViewCount,
    };
  }

  private async markAnonView(pid: string, anonId: string): Promise<PostViewAckDto | null> {
    const linkedIdentity = await this.prisma.viewerIdentity.findUnique({
      where: { anonId },
      select: { userId: true },
    });
    if (linkedIdentity?.userId) {
      const alreadyViewedAsUser = await this.prisma.postView.findUnique({
        where: { postId_userId: { postId: pid, userId: linkedIdentity.userId } },
        select: { postId: true },
      });
      if (alreadyViewedAsUser) {
        return this.markAuthenticatedView(linkedIdentity.userId, pid, anonId, 'anon_linked');
      }
    }

    const now = new Date();
    const created = await this.prisma.postAnonView.createMany({
      data: [{
        postId: pid,
        anonId,
        lastViewedAt: now,
        impressionCount: 1,
        lastImpressionAt: now,
      }],
      skipDuplicates: true,
    });

    let viewerIncrement = 0;
    let weightedIncrement = 0;
    let totalIncrement = 0;
    if (created.count > 0) {
      viewerIncrement = 1;
      weightedIncrement = ANON_VIEW_WEIGHT;
      totalIncrement = 1;
    } else {
      const refreshed = await this.prisma.postAnonView.updateMany({
        where: { postId: pid, anonId, lastViewedAt: { lt: cutoffForAnonRecount(now) } },
        data: { lastViewedAt: now },
      });
      if (refreshed.count > 0) {
        weightedIncrement = ANON_VIEW_WEIGHT;
      }
      const impressed = await this.prisma.postAnonView.updateMany({
        where: { postId: pid, anonId, lastImpressionAt: { lt: cutoffForTotalViewRecount(now) } },
        data: {
          lastImpressionAt: now,
          impressionCount: { increment: 1 },
        },
      });
      if (impressed.count > 0) totalIncrement = 1;
    }

    if (viewerIncrement === 0 && weightedIncrement <= 0 && totalIncrement === 0) {
      const unchanged = await this.postsRead.read.findUnique({
        where: { id: pid },
        select: { viewerCount: true, totalViewCount: true },
      });
      return {
        id: pid,
        uniqueCounted: false,
        totalCounted: false,
        viewerCount: unchanged?.viewerCount ?? 0,
        totalViewCount: unchanged?.totalViewCount ?? 0,
      };
    }

    const updated = await this.postsWrite.write.update({
      where: { id: pid },
      data: {
        ...(viewerIncrement !== 0 ? { viewerCount: { increment: viewerIncrement } } : {}),
        ...(weightedIncrement > 0 ? { weightedViewCount: { increment: weightedIncrement } } : {}),
        ...(totalIncrement !== 0 ? { totalViewCount: { increment: totalIncrement } } : {}),
      },
      select: { viewerCount: true, totalViewCount: true },
    });

    void this.redis.del(breakdownCacheKey(pid)).catch(() => undefined);
    await this.emitViewCounts(pid, {
      viewerCount: updated.viewerCount,
      totalViewCount: updated.totalViewCount,
      uniqueCounted: viewerIncrement !== 0,
      totalCounted: totalIncrement !== 0,
    });

    return {
      id: pid,
      uniqueCounted: viewerIncrement !== 0,
      totalCounted: totalIncrement !== 0,
      viewerCount: updated.viewerCount,
      totalViewCount: updated.totalViewCount,
    };
  }

  private async mergeOpenHistory(
    tx: import('@prisma/client').Prisma.TransactionClient,
    uid: string, pid: string, history: { openCount: number; lastOpenedAt: Date | null },
  ) {
    if (history.openCount > 0) await tx.postView.updateMany({
      where: { userId: uid, postId: pid }, data: { openCount: { increment: history.openCount } },
    });
    if (history.lastOpenedAt) await tx.postView.updateMany({
      where: { userId: uid, postId: pid, OR: [{ lastOpenedAt: null }, { lastOpenedAt: { lt: history.lastOpenedAt } }] },
      data: { lastOpenedAt: history.lastOpenedAt },
    });
  }

  /** Detail opens have their own 30s gate: a preceding feed impression cannot swallow one. */
  private async recordOpen(uid: string | null, pid: string, anonId: string | null, source?: string | null) {
    // permalink_engaged is retained for shipped Board clients; new clients send post_open.
    if (source !== 'post_open' && source !== 'permalink_engaged') return;
    if (!uid && anonId) {
      const linked = await this.prisma.viewerIdentity.findUnique({ where: { anonId }, select: { userId: true } });
      if (linked?.userId && await this.prisma.postView.findUnique({ where: { postId_userId: { postId: pid, userId: linked.userId } }, select: { postId: true } })) uid = linked.userId;
    }
    const now = new Date();
    const where = {
      postId: pid,
      post: { kind: 'board' as const },
      OR: [{ lastOpenedAt: null }, { lastOpenedAt: { lt: cutoffForTotalViewRecount(now) } }],
    };
    const data = { lastOpenedAt: now, openCount: { increment: 1 } };
    const updated = uid
      ? await this.prisma.postView.updateMany({ where: { ...where, userId: uid }, data })
      : anonId ? await this.prisma.postAnonView.updateMany({ where: { ...where, anonId }, data }) : null;
    if (updated?.count) this.posthog.capture(uid ?? anonId!, 'board_thread_opened', { post_id: pid, viewer_type: uid ? 'user' : 'guest' });
  }

  private async emitViewCounts(
    postId: string,
    opts: {
      viewerCount: number;
      totalViewCount: number;
      uniqueCounted: boolean;
      totalCounted: boolean;
      actorUserId?: string;
    },
  ): Promise<void> {
    const payload = {
      postId,
      version: new Date().toISOString(),
      reason: opts.uniqueCounted ? 'viewerCount' : 'totalViewCount',
      patch: { viewerCount: opts.viewerCount, totalViewCount: opts.totalViewCount },
    };
    if (opts.actorUserId && (opts.uniqueCounted || opts.totalCounted)) {
      this.presenceRealtime.emitPostsLiveUpdatedToUser(opts.actorUserId, payload);
    }
    if (opts.uniqueCounted) {
      this.presenceRealtime.emitPostsLiveUpdated(postId, payload);
      return;
    }
    if (!opts.totalCounted) return;
    const shouldEmit = await this.redis.setString(`view-emit:post:${postId}`, '1', {
      ttlMs: VIEW_ROOM_EMIT_THROTTLE_MS,
      onlyIfAbsent: true,
    });
    if (shouldEmit) {
      this.presenceRealtime.emitPostsLiveUpdated(postId, payload);
    }
  }

  async markViewedBatch(
    userId: string | null | undefined,
    postIds: string[],
    anonViewerId?: string | null,
    source?: string | null,
  ): Promise<PostViewAckDto[]> {
    const uid = (userId ?? '').trim();
    const anonId = sanitizeAnonViewerId(anonViewerId);
    if ((!uid && !anonId) || !Array.isArray(postIds) || postIds.length === 0) return [];

    const ids = [...new Set(postIds.map((id) => (id ?? '').trim()).filter(Boolean))].slice(0, BATCH_MAX);
    if (ids.length === 0) return [];

    let expanded: string[];
    try {
      expanded = await this.expandViewTargetIds(ids);
    } catch (err) {
      this.logger.warn(`markViewedBatch expand failed: ${String(err)}`);
      return [];
    }
    if (uid) {
      const acks = await this.markAuthenticatedViewsBatch(uid, expanded, anonId, source);
      // Embedded quotes receive impressions, but only explicitly opened IDs receive opens.
      await Promise.all(acks.filter((ack) => ids.includes(ack.id)).map((ack) => this.recordOpen(uid, ack.id, null, source)));
      try {
        const readableIds = acks.map((ack) => ack.id);
        const readIds = source === 'feed_scroll'
          ? (await this.postsRead.read.findMany({
              where: { id: { in: readableIds }, kind: { not: 'board' } },
              select: { id: true },
            })).map((post) => post.id)
          : readableIds;
        if (readIds.length) await this.notifications.markReadBySubjects(uid, readIds);
      } catch (err) {
        this.logger.warn(`markViewedBatch mark-read failed userId=${uid}: ${String(err)}`);
      }
      return acks;
    }

    return this.markAnonymousViewsBatch(expanded, anonId!, ids, source);
  }

  /** Guest batches use bounded writes and the rows actually claimed by each gate. */
  private async markAnonymousViewsBatch(
    postIds: string[], anonId: string, openedIds: string[], source?: string | null,
  ): Promise<PostViewAckDto[]> {
    try {
      const [posts, identity] = await Promise.all([
        this.postsRead.read.findMany({
          where: { id: { in: postIds }, deletedAt: null, visibility: 'public' },
          select: { id: true },
        }),
        this.prisma.viewerIdentity.findUnique({ where: { anonId }, select: { userId: true } }),
      ]);
      if (!posts.length) return [];
      const publicIds = posts.map(post => post.id);
      const linkedViews = identity?.userId ? await this.prisma.postView.findMany({
        where: { userId: identity.userId, postId: { in: publicIds } }, select: { postId: true },
      }) : [];
      const linkedIds = new Set(linkedViews.map(row => row.postId));
      const guestIds = publicIds.filter(id => !linkedIds.has(id));
      const acks = identity?.userId && linkedIds.size
        ? await this.markAuthenticatedViewsBatch(identity.userId, [...linkedIds], anonId, 'anon_linked')
        : [];
      const now = new Date();
      if (guestIds.length) {
        const counted = await this.prisma.$transaction(async tx => {
          const created = await tx.postAnonView.createManyAndReturn({
            data: guestIds.map(postId => ({ postId, anonId, lastViewedAt: now, impressionCount: 1, lastImpressionAt: now })),
            skipDuplicates: true, select: { postId: true },
          });
          const refreshed = await tx.postAnonView.updateManyAndReturn({
            where: { anonId, postId: { in: guestIds }, lastViewedAt: { lt: cutoffForAnonRecount(now) } },
            data: { lastViewedAt: now }, select: { postId: true },
          });
          const impressed = await tx.postAnonView.updateManyAndReturn({
            where: { anonId, postId: { in: guestIds }, lastImpressionAt: { lt: cutoffForTotalViewRecount(now) } },
            data: { lastImpressionAt: now, impressionCount: { increment: 1 } }, select: { postId: true },
          });
          const createdIds = new Set(created.map(row => row.postId));
          const weightedIds = new Set(refreshed.map(row => row.postId));
          const impressedIds = new Set(impressed.map(row => row.postId));
          const groups = [
            { ids: [...createdIds], unique: true, weighted: true, total: true },
            { ids: [...weightedIds].filter(id => impressedIds.has(id)), unique: false, weighted: true, total: true },
            { ids: [...weightedIds].filter(id => !impressedIds.has(id)), unique: false, weighted: true, total: false },
            { ids: [...impressedIds].filter(id => !weightedIds.has(id)), unique: false, weighted: false, total: true },
          ];
          for (const group of groups) {
            if (!group.ids.length) continue;
            await tx.post.updateMany({
              where: { id: { in: group.ids } },
              data: {
                ...(group.unique ? { viewerCount: { increment: 1 } } : {}),
                ...(group.weighted ? { weightedViewCount: { increment: ANON_VIEW_WEIGHT } } : {}),
                ...(group.total ? { totalViewCount: { increment: 1 } } : {}),
              },
            });
          }
          const counts = await tx.post.findMany({
            where: { id: { in: guestIds } }, select: { id: true, viewerCount: true, totalViewCount: true },
          });
          return counts.map(post => ({ ...post, uniqueCounted: createdIds.has(post.id), totalCounted: createdIds.has(post.id) || impressedIds.has(post.id) }));
        });
        const changed = counted.filter(ack => ack.uniqueCounted || ack.totalCounted);
        if (changed.length) {
          void this.redis.del(...changed.map(ack => breakdownCacheKey(ack.id))).catch(() => undefined);
          await Promise.all(changed.map(ack => this.emitViewCounts(ack.id, ack)));
        }
        acks.push(...counted);
      }
      // Only actual detail opens count, never embedded quote/repost impressions.
      if (source === 'post_open' || source === 'permalink_engaged') {
        const where = {
          postId: { in: acks.map(ack => ack.id).filter(id => openedIds.includes(id)) },
          post: { kind: 'board' as const },
          OR: [{ lastOpenedAt: null }, { lastOpenedAt: { lt: cutoffForTotalViewRecount(now) } }],
        };
        const data = { lastOpenedAt: now, openCount: { increment: 1 } };
        const guestOpens = await this.prisma.postAnonView.updateManyAndReturn({
          where: { ...where, anonId }, data, select: { postId: true },
        });
        for (const row of guestOpens) this.posthog.capture(anonId, 'board_thread_opened', { post_id: row.postId, viewer_type: 'guest' });
        if (identity?.userId && linkedIds.size) {
          const userOpens = await this.prisma.postView.updateManyAndReturn({
            where: { ...where, userId: identity.userId, postId: { in: [...linkedIds].filter(id => openedIds.includes(id)) } },
            data, select: { postId: true },
          });
          for (const row of userOpens) this.posthog.capture(identity.userId, 'board_thread_opened', { post_id: row.postId, viewer_type: 'user' });
        }
      }
      return acks;
    } catch (err) {
      this.logger.warn(`markAnonymousViewsBatch failed: ${String(err)}`);
      return [];
    }
  }

  /**
   * One transaction for a scroll batch instead of N markViewed transactions.
   * createManyAndReturn keeps first-view increments race-safe.
   */
  private async markAuthenticatedViewsBatch(
    uid: string,
    postIds: string[],
    anonId: string | null,
    source?: string | null,
  ): Promise<PostViewAckDto[]> {
    try {
      const [posts, viewer] = await Promise.all([
        this.postsRead.read.findMany({
          where: { id: { in: postIds }, deletedAt: null },
          select: { id: true, visibility: true, userId: true, viewerCount: true, totalViewCount: true },
        }),
        this.prisma.user.findFirst({
          where: { id: uid },
          select: { isBot: true, verifiedStatus: true, premium: true, premiumPlus: true },
        }),
      ]);
      if (viewer?.isBot) return [];

      const accessible = posts.filter(
        (post) => post.userId === uid || viewerCanAccessVisibility(post.visibility, viewer),
      );
      if (accessible.length === 0) return [];
      const accessibleIds = accessible.map((post) => post.id);

      if (anonId) {
        await this.prisma.viewerIdentity.upsert({
          where: { anonId },
          create: { anonId, userId: uid },
          update: { userId: uid },
        });
      }

      const now = new Date();
      const lastSource = normalizeViewSource(source);
      const lastSeenCutoff = cutoffForLastSeenRefresh(now);
      const impressionCutoff = cutoffForTotalViewRecount(now);

      const [existingViews, anonRows] = await Promise.all([
        this.prisma.postView.findMany({
          where: { userId: uid, postId: { in: accessibleIds } },
          select: { postId: true, lastSeenAt: true, lastImpressionAt: true },
        }),
        anonId
          ? this.prisma.postAnonView.findMany({
              where: { anonId, postId: { in: accessibleIds } },
              select: { postId: true, openCount: true, lastOpenedAt: true },
            })
          : Promise.resolve([] as Array<{ postId: string; openCount: number; lastOpenedAt: Date | null }>),
      ]);

      const existingByPostId = new Map(existingViews.map((row) => [row.postId, row]));
      const anonPostIds = new Set(anonRows.map((row) => row.postId));
      const toCreate = accessibleIds.filter((id) => !existingByPostId.has(id));
      const toRefreshLastSeen = existingViews
        .filter((row) => row.lastSeenAt < lastSeenCutoff)
        .map((row) => row.postId);
      const toRefreshImpression = existingViews
        .filter((row) => row.lastImpressionAt < impressionCutoff)
        .map((row) => row.postId);

      const counted = await this.prisma.$transaction(async (tx) => {
        const created =
          toCreate.length > 0
            ? await tx.postView.createManyAndReturn({
                data: toCreate.map((postId) => ({
                  postId,
                  userId: uid,
                  lastSeenAt: now,
                  seenCount: 1,
                  impressionCount: 1,
                  lastImpressionAt: now,
                  lastSource,
                })),
                skipDuplicates: true,
                select: { postId: true },
              })
            : [];

        if (toRefreshLastSeen.length > 0) {
          await tx.postView.updateMany({
            where: {
              userId: uid,
              postId: { in: toRefreshLastSeen },
              lastSeenAt: { lt: lastSeenCutoff },
            },
            data: { lastSeenAt: now, seenCount: { increment: 1 }, lastSource },
          });
        }
        const impressed = toRefreshImpression.length > 0
          ? await tx.postView.updateManyAndReturn({
              where: { userId: uid, postId: { in: toRefreshImpression }, lastImpressionAt: { lt: impressionCutoff } },
              data: { lastImpressionAt: now, impressionCount: { increment: 1 } },
              select: { postId: true },
            })
          : [];
        if (anonId) {
          for (const anon of anonRows) {
            const consumed = await tx.postAnonView.deleteMany({ where: { postId: anon.postId, anonId } });
            if (consumed.count) await this.mergeOpenHistory(tx, uid, anon.postId, anon);
          }
        }

        const createdIds = new Set(created.map((row) => row.postId));
        const firstNoAnon = [...createdIds].filter((id) => !anonPostIds.has(id));
        const firstConsumedAnon = [...createdIds].filter((id) => anonPostIds.has(id));
        const impressionOnly = impressed.map((row) => row.postId).filter((id) => !createdIds.has(id));

        if (firstNoAnon.length > 0) {
          await tx.post.updateMany({
            where: { id: { in: firstNoAnon } },
            data: {
              viewerCount: { increment: 1 },
              weightedViewCount: { increment: LOGGED_IN_VIEW_WEIGHT },
              totalViewCount: { increment: 1 },
            },
          });
        }
        if (firstConsumedAnon.length > 0) {
          await tx.post.updateMany({
            where: { id: { in: firstConsumedAnon } },
            data: {
              weightedViewCount: { increment: 0.5 },
              totalViewCount: { increment: 1 },
            },
          });
        }
        if (impressionOnly.length > 0) {
          await tx.post.updateMany({
            where: { id: { in: impressionOnly } },
            data: { totalViewCount: { increment: 1 } },
          });
        }

        return { created, impressionOnly };
      });

      const createdIds = new Set(counted.created.map((row) => row.postId));
      if (createdIds.size > 0 || toRefreshLastSeen.length > 0) {
        await this.cacheInvalidation.bumpForYouUser(uid).catch(() => undefined);
      }

      const incrementByPostId = new Map<string, { viewer: number; total: number }>();
      for (const id of createdIds) {
        incrementByPostId.set(id, { viewer: anonPostIds.has(id) ? 0 : 1, total: 1 });
      }
      for (const id of counted.impressionOnly) {
        if (!createdIds.has(id)) incrementByPostId.set(id, { viewer: 0, total: 1 });
      }

      const acks: PostViewAckDto[] = [];
      const emitJobs: Array<Promise<void>> = [];
      const breakdownKeys: string[] = [];
      for (const post of accessible) {
        const inc = incrementByPostId.get(post.id) ?? { viewer: 0, total: 0 };
        const uniqueCounted = inc.viewer !== 0;
        const totalCounted = inc.total !== 0;
        const viewerCount = post.viewerCount + inc.viewer;
        const totalViewCount = post.totalViewCount + inc.total;
        if (createdIds.has(post.id)) {
          this.posthog.capture(uid, 'post_viewed', {
            post_id: post.id,
            source: lastSource ?? 'unknown',
            viewer_type: 'user',
          });
        }
        if (uniqueCounted || totalCounted) {
          breakdownKeys.push(breakdownCacheKey(post.id));
          emitJobs.push(
            this.emitViewCounts(post.id, {
              viewerCount,
              totalViewCount,
              uniqueCounted,
              totalCounted,
              actorUserId: uid,
            }),
          );
        }
        acks.push({
          id: post.id,
          uniqueCounted,
          totalCounted,
          viewerCount,
          totalViewCount,
        });
      }
      if (breakdownKeys.length > 0) {
        void this.redis.del(...breakdownKeys).catch(() => undefined);
      }
      if (emitJobs.length > 0) await Promise.all(emitJobs);
      return acks;
    } catch (err) {
      this.logger.warn(`markAuthenticatedViewsBatch failed userId=${uid}: ${String(err)}`);
      return [];
    }
  }

  async expandViewTargetIds(ids: string[]): Promise<string[]> {
    if (ids.length === 0) return [];

    const rows = await this.postsRead.read.findMany({
      where: { id: { in: ids }, deletedAt: null },
      select: { id: true, kind: true, repostedPostId: true, quotedPostId: true },
    });

    const out = new Set(ids);
    for (const row of rows) {
      if (row.kind === 'repost' && row.repostedPostId) out.add(row.repostedPostId);
      if (row.quotedPostId) out.add(row.quotedPostId);
    }

    return [...out].slice(0, BATCH_MAX);
  }

  async getBreakdown(
    postId: string,
    viewerUserId?: string | null,
    options?: { fresh?: boolean },
  ): Promise<PostViewBreakdown> {
    const pid = (postId ?? '').trim();
    const uid = (viewerUserId ?? '').trim() || null;

    const post = await this.postsRead.read.findFirst({
      where: { id: pid, deletedAt: null },
      select: { visibility: true, userId: true, viewerCount: true, totalViewCount: true },
    });
    if (!post) throw new NotFoundException('Post not found.');

    const isSelf = Boolean(uid && post.userId === uid);
    if (!isSelf && post.visibility === 'onlyMe') {
      throw new NotFoundException('Post not found.');
    }

    const computeBreakdown = async (): Promise<PostViewBreakdown> => {
      const rows = await this.prisma.$queryRaw<
        Array<{
          premium: bigint;
          verified: bigint;
          unverified: bigint;
          premium_total: bigint;
          verified_total: bigint;
          unverified_total: bigint;
        }>
      >`
        SELECT
          COUNT(*) FILTER (WHERE u.premium OR u."premiumPlus")                                        AS premium,
          COUNT(*) FILTER (WHERE u."verifiedStatus" != 'none' AND NOT (u.premium OR u."premiumPlus")) AS verified,
          COUNT(*) FILTER (WHERE u."verifiedStatus" = 'none'  AND NOT (u.premium OR u."premiumPlus")) AS unverified,
          COALESCE(SUM(pv."impressionCount") FILTER (WHERE u.premium OR u."premiumPlus"), 0) AS premium_total,
          COALESCE(SUM(pv."impressionCount") FILTER (
            WHERE u."verifiedStatus" != 'none' AND NOT (u.premium OR u."premiumPlus")
          ), 0) AS verified_total,
          COALESCE(SUM(pv."impressionCount") FILTER (
            WHERE u."verifiedStatus" = 'none' AND NOT (u.premium OR u."premiumPlus")
          ), 0) AS unverified_total
        FROM "PostView" pv
        JOIN "User" u ON u.id = pv."userId"
        WHERE pv."postId" = ${pid}
      `;

      const row = rows[0] ?? {
        premium: 0n,
        verified: 0n,
        unverified: 0n,
        premium_total: 0n,
        verified_total: 0n,
        unverified_total: 0n,
      };
      const premium = Number(row.premium ?? 0);
      const verified = Number(row.verified ?? 0);
      const unverified = Number(row.unverified ?? 0);
      const premiumTotal = Number(row.premium_total ?? 0);
      const verifiedTotal = Number(row.verified_total ?? 0);
      const unverifiedTotal = Number(row.unverified_total ?? 0);

      const total = Math.max(0, Math.floor(Number(post.viewerCount ?? 0)));
      const totalViewCount = Math.max(0, Math.floor(Number(post.totalViewCount ?? total)));
      const guest = Math.max(0, total - (premium + verified + unverified));
      const guestTotal = Math.max(0, totalViewCount - (premiumTotal + verifiedTotal + unverifiedTotal));

      return {
        premium,
        verified,
        unverified,
        guest,
        total,
        totalViewCount,
        premiumTotal,
        verifiedTotal,
        unverifiedTotal,
        guestTotal,
      };
    };

    if (options?.fresh) {
      return await computeBreakdown();
    }

    return this.cache.getOrSetJson<PostViewBreakdown>({
      enabled: true,
      key: breakdownCacheKey(pid),
      ttlSeconds: BREAKDOWN_TTL_SECONDS,
      compute: computeBreakdown,
    });
  }
}
