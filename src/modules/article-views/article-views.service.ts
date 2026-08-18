import { Injectable, Logger, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { CacheService } from '../redis/cache.service';
import { RedisService } from '../redis/redis.service';
import { PresenceRealtimeService } from '../presence/presence-realtime.service';
import { NotificationsService } from '../notifications/notifications.service';
import type { ArticleViewAckDto } from '../../common/dto/view-ack.dto';
import {
  ANON_VIEW_WEIGHT,
  LOGGED_IN_VIEW_WEIGHT,
  VIEW_ROOM_EMIT_THROTTLE_MS,
  cutoffForAnonRecount,
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

function breakdownCacheKey(articleId: string): string {
  return `cache:article-view-breakdown:${articleId}`;
}

export type ArticleViewBreakdown = {
  premium: number;
  verified: number;
  unverified: number;
  guest: number;
  /** Unique people — keep this name for shipped clients. */
  total: number;
  totalViewCount: number;
  premiumTotal: number;
  verifiedTotal: number;
  unverifiedTotal: number;
  guestTotal: number;
};

@Injectable()
export class ArticleViewsService {
  private readonly logger = new Logger(ArticleViewsService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly cache: CacheService,
    private readonly redis: RedisService,
    private readonly presenceRealtime: PresenceRealtimeService,
    private readonly notifications: NotificationsService,
  ) {}

  async markViewed(
    userId: string | null | undefined,
    articleId: string,
    anonViewerId?: string | null,
    _source?: string | null,
  ): Promise<ArticleViewAckDto | null> {
    const uid = (userId ?? '').trim();
    const aid = (articleId ?? '').trim();
    const anonId = sanitizeAnonViewerId(anonViewerId);
    if (!aid || (!uid && !anonId)) return null;

    try {
      const article = await this.prisma.article.findFirst({
        where: { id: aid, deletedAt: null },
        select: { id: true, visibility: true, authorId: true },
      });
      if (!article) return null;

      if (uid && article.authorId !== uid) {
        const viewer = await this.prisma.user.findFirst({
          where: { id: uid },
          select: { verifiedStatus: true, premium: true, premiumPlus: true },
        });
        if (!viewerCanAccessVisibility(article.visibility, viewer)) return null;
      }
      if (!uid && article.visibility !== 'public') return null;

      if (uid && anonId) {
        await this.prisma.viewerIdentity.upsert({
          where: { anonId },
          create: { anonId, userId: uid },
          update: { userId: uid },
        });
      }

      if (uid) {
        return await this.markAuthenticatedView(uid, aid, anonId);
      }
      return await this.markAnonView(aid, anonId as string);
    } catch (err) {
      this.logger.warn(`markViewed failed for articleId=${aid} userId=${uid}: ${String(err)}`);
      return null;
    }
  }

  private async markAuthenticatedView(
    uid: string,
    aid: string,
    anonId: string | null,
  ): Promise<ArticleViewAckDto | null> {
    const now = new Date();
    const result = await this.prisma.$transaction(async (tx) => {
      const created = await tx.articleView.createMany({
        data: [{
          articleId: aid,
          userId: uid,
          impressionCount: 1,
          lastImpressionAt: now,
        }],
        skipDuplicates: true,
      });
      const consumedAnonCount = anonId
        ? (await tx.articleAnonView.deleteMany({ where: { articleId: aid, anonId } })).count
        : 0;

      let viewIncrementLocal = 0;
      let weightedIncrementLocal = 0;
      let totalIncrementLocal = 0;
      if (created.count > 0) {
        viewIncrementLocal = consumedAnonCount > 0 ? 0 : 1;
        weightedIncrementLocal = consumedAnonCount > 0 ? 0.5 : LOGGED_IN_VIEW_WEIGHT;
        totalIncrementLocal = 1;
      } else {
        const impressed = await tx.articleView.updateMany({
          where: {
            articleId: aid,
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

      if (viewIncrementLocal !== 0 || weightedIncrementLocal !== 0 || totalIncrementLocal !== 0) {
        const updated = await tx.article.update({
          where: { id: aid },
          data: {
            ...(viewIncrementLocal !== 0 ? { viewCount: { increment: viewIncrementLocal } } : {}),
            ...(weightedIncrementLocal !== 0 ? { weightedViewCount: { increment: weightedIncrementLocal } } : {}),
            ...(totalIncrementLocal !== 0 ? { totalViewCount: { increment: totalIncrementLocal } } : {}),
          },
          select: { viewCount: true, totalViewCount: true },
        });
        return {
          viewIncrementLocal,
          weightedIncrementLocal,
          totalIncrementLocal,
          viewCount: updated.viewCount,
          totalViewCount: updated.totalViewCount,
        };
      }

      const unchanged = await tx.article.findUnique({
        where: { id: aid },
        select: { viewCount: true, totalViewCount: true },
      });
      return {
        viewIncrementLocal,
        weightedIncrementLocal,
        totalIncrementLocal,
        viewCount: unchanged?.viewCount ?? 0,
        totalViewCount: unchanged?.totalViewCount ?? 0,
      };
    });

    const uniqueCounted = result.viewIncrementLocal !== 0;
    const totalCounted = result.totalIncrementLocal !== 0;
    if (uniqueCounted || totalCounted) {
      void this.redis.del(breakdownCacheKey(aid)).catch(() => undefined);
      await this.emitViewCounts(aid, {
        viewCount: result.viewCount,
        totalViewCount: result.totalViewCount,
        uniqueCounted,
        totalCounted,
        actorUserId: uid,
      });
    }
    await this.notifications.markReadBySubject(uid, { articleId: aid });
    return {
      id: aid,
      uniqueCounted,
      totalCounted,
      viewCount: result.viewCount,
      totalViewCount: result.totalViewCount,
    };
  }

  private async markAnonView(aid: string, anonId: string): Promise<ArticleViewAckDto | null> {
    const linkedIdentity = await this.prisma.viewerIdentity.findUnique({
      where: { anonId },
      select: { userId: true },
    });
    if (linkedIdentity?.userId) {
      const alreadyViewedAsUser = await this.prisma.articleView.findUnique({
        where: { articleId_userId: { articleId: aid, userId: linkedIdentity.userId } },
        select: { articleId: true },
      });
      if (alreadyViewedAsUser) {
        return this.markAuthenticatedView(linkedIdentity.userId, aid, anonId);
      }
    }

    const now = new Date();
    const created = await this.prisma.articleAnonView.createMany({
      data: [{
        articleId: aid,
        anonId,
        lastViewedAt: now,
        impressionCount: 1,
        lastImpressionAt: now,
      }],
      skipDuplicates: true,
    });

    let viewIncrement = 0;
    let weightedIncrement = 0;
    let totalIncrement = 0;
    if (created.count > 0) {
      viewIncrement = 1;
      weightedIncrement = ANON_VIEW_WEIGHT;
      totalIncrement = 1;
    } else {
      const refreshed = await this.prisma.articleAnonView.updateMany({
        where: { articleId: aid, anonId, lastViewedAt: { lt: cutoffForAnonRecount(now) } },
        data: { lastViewedAt: now },
      });
      if (refreshed.count > 0) {
        weightedIncrement = ANON_VIEW_WEIGHT;
      }
      const impressed = await this.prisma.articleAnonView.updateMany({
        where: { articleId: aid, anonId, lastImpressionAt: { lt: cutoffForTotalViewRecount(now) } },
        data: {
          lastImpressionAt: now,
          impressionCount: { increment: 1 },
        },
      });
      if (impressed.count > 0) totalIncrement = 1;
    }

    if (viewIncrement === 0 && weightedIncrement <= 0 && totalIncrement === 0) {
      const unchanged = await this.prisma.article.findUnique({
        where: { id: aid },
        select: { viewCount: true, totalViewCount: true },
      });
      return {
        id: aid,
        uniqueCounted: false,
        totalCounted: false,
        viewCount: unchanged?.viewCount ?? 0,
        totalViewCount: unchanged?.totalViewCount ?? 0,
      };
    }

    const updated = await this.prisma.article.update({
      where: { id: aid },
      data: {
        ...(viewIncrement !== 0 ? { viewCount: { increment: viewIncrement } } : {}),
        ...(weightedIncrement > 0 ? { weightedViewCount: { increment: weightedIncrement } } : {}),
        ...(totalIncrement !== 0 ? { totalViewCount: { increment: totalIncrement } } : {}),
      },
      select: { viewCount: true, totalViewCount: true },
    });

    void this.redis.del(breakdownCacheKey(aid)).catch(() => undefined);
    await this.emitViewCounts(aid, {
      viewCount: updated.viewCount,
      totalViewCount: updated.totalViewCount,
      uniqueCounted: viewIncrement !== 0,
      totalCounted: totalIncrement !== 0,
    });

    return {
      id: aid,
      uniqueCounted: viewIncrement !== 0,
      totalCounted: totalIncrement !== 0,
      viewCount: updated.viewCount,
      totalViewCount: updated.totalViewCount,
    };
  }

  private async emitViewCounts(
    articleId: string,
    opts: {
      viewCount: number;
      totalViewCount: number;
      uniqueCounted: boolean;
      totalCounted: boolean;
      actorUserId?: string;
    },
  ): Promise<void> {
    const payload = {
      articleId,
      version: new Date().toISOString(),
      reason: opts.uniqueCounted ? 'viewCount' : 'totalViewCount',
      patch: { viewCount: opts.viewCount, totalViewCount: opts.totalViewCount },
    };
    if (opts.actorUserId && (opts.uniqueCounted || opts.totalCounted)) {
      this.presenceRealtime.emitArticlesLiveUpdatedToUser(opts.actorUserId, payload);
    }
    if (opts.uniqueCounted) {
      this.presenceRealtime.emitArticlesLiveUpdated(articleId, payload);
      return;
    }
    if (!opts.totalCounted) return;
    const shouldEmit = await this.redis.setString(`view-emit:article:${articleId}`, '1', {
      ttlMs: VIEW_ROOM_EMIT_THROTTLE_MS,
      onlyIfAbsent: true,
    });
    if (shouldEmit) {
      this.presenceRealtime.emitArticlesLiveUpdated(articleId, payload);
    }
  }

  async markViewedBatch(
    userId: string | null | undefined,
    articleIds: string[],
    anonViewerId?: string | null,
    source?: string | null,
  ): Promise<ArticleViewAckDto[]> {
    const uid = (userId ?? '').trim();
    const anonId = sanitizeAnonViewerId(anonViewerId);
    if ((!uid && !anonId) || !Array.isArray(articleIds) || articleIds.length === 0) return [];

    const ids = [...new Set(articleIds.map((id) => (id ?? '').trim()).filter(Boolean))].slice(0, BATCH_MAX);
    if (ids.length === 0) return [];

    return (await Promise.all(ids.map((aid) => this.markViewed(uid || null, aid, anonId, source))))
      .filter((ack): ack is ArticleViewAckDto => ack != null);
  }

  async getBreakdown(articleId: string, viewerUserId?: string | null): Promise<ArticleViewBreakdown> {
    const aid = (articleId ?? '').trim();
    const uid = (viewerUserId ?? '').trim() || null;

    const article = await this.prisma.article.findFirst({
      where: { id: aid, deletedAt: null },
      select: { visibility: true, authorId: true, viewCount: true, totalViewCount: true },
    });
    if (!article) throw new NotFoundException('Article not found.');

    const isSelf = Boolean(uid && article.authorId === uid);
    if (!isSelf) {
      if (!uid) {
        if (article.visibility !== 'public') throw new NotFoundException('Article not found.');
      } else {
        const viewer = await this.prisma.user.findFirst({
          where: { id: uid },
          select: { verifiedStatus: true, premium: true, premiumPlus: true },
        });
        if (!viewerCanAccessVisibility(article.visibility, viewer)) {
          throw new NotFoundException('Article not found.');
        }
      }
    }

    return this.cache.getOrSetJson<ArticleViewBreakdown>({
      enabled: true,
      key: breakdownCacheKey(aid),
      ttlSeconds: BREAKDOWN_TTL_SECONDS,
      compute: async () => {
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
            COALESCE(SUM(av."impressionCount") FILTER (WHERE u.premium OR u."premiumPlus"), 0) AS premium_total,
            COALESCE(SUM(av."impressionCount") FILTER (
              WHERE u."verifiedStatus" != 'none' AND NOT (u.premium OR u."premiumPlus")
            ), 0) AS verified_total,
            COALESCE(SUM(av."impressionCount") FILTER (
              WHERE u."verifiedStatus" = 'none' AND NOT (u.premium OR u."premiumPlus")
            ), 0) AS unverified_total
          FROM "ArticleView" av
          JOIN "User" u ON u.id = av."userId"
          WHERE av."articleId" = ${aid}
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

        const total = Math.max(0, Math.floor(Number(article.viewCount ?? 0)));
        const totalViewCount = Math.max(0, Math.floor(Number(article.totalViewCount ?? total)));
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
      },
    });
  }
}
