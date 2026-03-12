import { Injectable, Logger, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { CacheService } from '../redis/cache.service';
import { RedisService } from '../redis/redis.service';
import { PresenceRealtimeService } from '../presence/presence-realtime.service';
import { NotificationsService } from '../notifications/notifications.service';
import {
  ANON_VIEW_WEIGHT,
  LOGGED_IN_VIEW_WEIGHT,
  cutoffForAnonRecount,
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
  return false; // onlyMe — author check handles this before we're called
}

function breakdownCacheKey(articleId: string): string {
  return `cache:article-view-breakdown:${articleId}`;
}

export type ArticleViewBreakdown = {
  premium: number;
  verified: number;
  unverified: number;
  total: number;
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

  /**
   * Record that a user viewed an article. Idempotent: multiple calls for the same
   * (userId, articleId) pair are safe and will not double-count.
   * Emits a WebSocket event if this is the first (unique) view.
   */
  async markViewed(
    userId: string | null | undefined,
    articleId: string,
    anonViewerId?: string | null,
    _source?: string | null,
  ): Promise<void> {
    const uid = (userId ?? '').trim();
    const aid = (articleId ?? '').trim();
    const anonId = sanitizeAnonViewerId(anonViewerId);
    if (!aid || (!uid && !anonId)) return;

    try {
      const article = await this.prisma.article.findFirst({
        where: { id: aid, deletedAt: null },
        select: { id: true, visibility: true, authorId: true },
      });
      if (!article) return;

      // Authors can always view their own articles; everyone else must meet the tier requirement.
      if (uid && article.authorId !== uid) {
        const viewer = await this.prisma.user.findFirst({
          where: { id: uid },
          select: { verifiedStatus: true, premium: true, premiumPlus: true },
        });
        if (!viewerCanAccessVisibility(article.visibility, viewer)) return;
      }
      if (!uid && article.visibility !== 'public') return;

      if (uid && anonId) {
        await this.prisma.viewerIdentity.upsert({
          where: { anonId },
          create: { anonId, userId: uid },
          update: { userId: uid },
        });
      }

      let weightedIncrement = 0;
      let viewIncrement = 0;
      if (uid) {
        const now = new Date();
        const result = await this.prisma.$transaction(async (tx) => {
          const created = await tx.articleView.createMany({
            data: [{ articleId: aid, userId: uid }],
            skipDuplicates: true,
          });
          const consumedAnonCount = anonId
            ? (
                await tx.articleAnonView.deleteMany({
                  where: { articleId: aid, anonId },
                })
              ).count
            : 0;

          let weightedIncrementLocal = 0;
          let viewIncrementLocal = 0;
          if (created.count > 0) {
            viewIncrementLocal = consumedAnonCount > 0 ? 0 : 1;
            weightedIncrementLocal = consumedAnonCount > 0 ? 0.5 : LOGGED_IN_VIEW_WEIGHT;
          }

          if (viewIncrementLocal !== 0 || weightedIncrementLocal !== 0) {
            const updated = await tx.article.update({
              where: { id: aid },
              data: {
                viewCount: { increment: viewIncrementLocal },
                weightedViewCount: { increment: weightedIncrementLocal },
              },
              select: { viewCount: true },
            });
            return { viewIncrementLocal, weightedIncrementLocal, viewCount: updated.viewCount };
          }

          const unchanged = await tx.article.findUnique({
            where: { id: aid },
            select: { viewCount: true },
          });
          return { viewIncrementLocal, weightedIncrementLocal, viewCount: unchanged?.viewCount ?? 0 };
        });

        viewIncrement = result.viewIncrementLocal;
        weightedIncrement = result.weightedIncrementLocal;

        if (viewIncrement !== 0 || weightedIncrement !== 0) {
          void this.redis.del(breakdownCacheKey(aid)).catch(() => undefined);
          this.presenceRealtime.emitArticlesLiveUpdated(aid, {
            articleId: aid,
            version: now.toISOString(),
            reason: 'viewCount',
            patch: { viewCount: result.viewCount },
          });
        }
        await this.notifications.markReadBySubject(uid, { articleId: aid });
        return;
      } else if (anonId) {
        const linkedIdentity = await this.prisma.viewerIdentity.findUnique({
          where: { anonId },
          select: { userId: true },
        });
        if (linkedIdentity?.userId) {
          const alreadyViewedAsUser = await this.prisma.articleView.findUnique({
            where: { articleId_userId: { articleId: aid, userId: linkedIdentity.userId } },
            select: { articleId: true },
          });
          if (alreadyViewedAsUser) return;
        }

        const now = new Date();
        const created = await this.prisma.articleAnonView.createMany({
          data: [{ articleId: aid, anonId, lastViewedAt: now }],
          skipDuplicates: true,
        });
        if (created.count > 0) {
          viewIncrement = 1;
          weightedIncrement = ANON_VIEW_WEIGHT;
        } else {
          const refreshed = await this.prisma.articleAnonView.updateMany({
            where: { articleId: aid, anonId, lastViewedAt: { lt: cutoffForAnonRecount(now) } },
            data: { lastViewedAt: now },
          });
          if (refreshed.count > 0) {
            viewIncrement = 1;
            weightedIncrement = ANON_VIEW_WEIGHT;
          }
        }
      }
      if (weightedIncrement <= 0) return;

      const updated = await this.prisma.article.update({
        where: { id: aid },
        data: {
          viewCount: { increment: viewIncrement },
          weightedViewCount: { increment: weightedIncrement },
        },
        select: { viewCount: true },
      });

      void this.redis.del(breakdownCacheKey(aid)).catch(() => undefined);

      this.presenceRealtime.emitArticlesLiveUpdated(aid, {
        articleId: aid,
        version: new Date().toISOString(),
        reason: 'viewCount',
        patch: { viewCount: updated.viewCount },
      });
    } catch (err) {
      this.logger.warn(`markViewed failed for articleId=${aid} userId=${uid}: ${String(err)}`);
    }
  }

  /**
   * Batch version of markViewed. Caps at BATCH_MAX IDs to prevent abuse.
   */
  async markViewedBatch(
    userId: string | null | undefined,
    articleIds: string[],
    anonViewerId?: string | null,
    source?: string | null,
  ): Promise<void> {
    const uid = (userId ?? '').trim();
    const anonId = sanitizeAnonViewerId(anonViewerId);
    if ((!uid && !anonId) || !Array.isArray(articleIds) || articleIds.length === 0) return;

    const ids = [...new Set(articleIds.map((id) => (id ?? '').trim()).filter(Boolean))].slice(0, BATCH_MAX);
    if (ids.length === 0) return;

    await Promise.all(ids.map((aid) => this.markViewed(uid || null, aid, anonId, source)));
  }

  /**
   * Returns a breakdown of viewers by tier (cached for BREAKDOWN_TTL_SECONDS).
   * premium: users with premium OR premiumPlus
   * verified: verifiedStatus != 'none' AND NOT (premium OR premiumPlus)
   * unverified: verifiedStatus == 'none' AND NOT (premium OR premiumPlus)
   */
  async getBreakdown(articleId: string, viewerUserId: string): Promise<ArticleViewBreakdown> {
    const aid = (articleId ?? '').trim();

    const article = await this.prisma.article.findUnique({
      where: { id: aid },
      select: { authorId: true },
    });
    if (!article || article.authorId !== viewerUserId) {
      throw new NotFoundException('Article not found.');
    }

    return this.cache.getOrSetJson<ArticleViewBreakdown>({
      enabled: true,
      key: breakdownCacheKey(aid),
      ttlSeconds: BREAKDOWN_TTL_SECONDS,
      compute: async () => {
        const rows = await this.prisma.$queryRaw<
          Array<{ premium: bigint; verified: bigint; unverified: bigint }>
        >`
          SELECT
            COUNT(*) FILTER (WHERE u.premium OR u."premiumPlus")                                        AS premium,
            COUNT(*) FILTER (WHERE u."verifiedStatus" != 'none' AND NOT (u.premium OR u."premiumPlus")) AS verified,
            COUNT(*) FILTER (WHERE u."verifiedStatus" = 'none'  AND NOT (u.premium OR u."premiumPlus")) AS unverified
          FROM "ArticleView" av
          JOIN "User" u ON u.id = av."userId"
          WHERE av."articleId" = ${aid}
        `;

        const row = rows[0] ?? { premium: 0n, verified: 0n, unverified: 0n };
        const premium = Number(row.premium ?? 0);
        const verified = Number(row.verified ?? 0);
        const unverified = Number(row.unverified ?? 0);

        return { premium, verified, unverified, total: premium + verified + unverified };
      },
    });
  }
}
