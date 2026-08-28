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
  ) {}

  /**
   * Record that a user viewed a post.
   * Unique viewerCount stays 1 per person. Total increments on first look and
   * again when lastImpressionAt is older than 30s.
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
      const post = await this.prisma.post.findFirst({
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
        return await this.markAuthenticatedView(uid, pid, anonId, source, opts);
      }
      return await this.markAnonView(pid, anonId as string);
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
      const consumedAnonCount = anonId
        ? (await tx.postAnonView.deleteMany({ where: { postId: pid, anonId } })).count
        : 0;

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
      void this.cacheInvalidation.bumpForYouUser(uid).catch(() => undefined);
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
    if (!opts?.skipMarkRead) {
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
      const unchanged = await this.prisma.post.findUnique({
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

    const updated = await this.prisma.post.update({
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
    const acks = (await Promise.all(
      expanded.map((pid) => this.markViewed(uid || null, pid, anonId, source, { skipMarkRead: true })),
    )).filter((ack): ack is PostViewAckDto => ack != null);
    if (uid) {
      try {
        await this.notifications.markReadBySubjects(uid, expanded);
      } catch (err) {
        this.logger.warn(`markViewedBatch mark-read failed userId=${uid}: ${String(err)}`);
      }
    }
    return acks;
  }

  async expandViewTargetIds(ids: string[]): Promise<string[]> {
    if (ids.length === 0) return [];

    const rows = await this.prisma.post.findMany({
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

    const post = await this.prisma.post.findFirst({
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
