import { Injectable, Logger } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { CacheService } from '../redis/cache.service';
import { RedisService } from '../redis/redis.service';
import { PresenceRealtimeService } from '../presence/presence-realtime.service';
import { PosthogService } from '../../common/posthog/posthog.service';
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
  return false; // onlyMe — author check is handled before this is called
}

function breakdownCacheKey(postId: string): string {
  return `cache:post-view-breakdown:${postId}`;
}

export type PostViewBreakdown = {
  premium: number;
  verified: number;
  unverified: number;
  guest: number;
  total: number;
};

@Injectable()
export class PostViewsService {
  private readonly logger = new Logger(PostViewsService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly cache: CacheService,
    private readonly redis: RedisService,
    private readonly presenceRealtime: PresenceRealtimeService,
    private readonly posthog: PosthogService,
    private readonly notifications: NotificationsService,
  ) {}

  /**
   * Record that a user viewed a post. Idempotent: multiple calls for the same
   * (userId, postId) pair are safe and will not double-count.
   * Emits a WebSocket event if this is the first (unique) view.
   */
  async markViewed(userId: string | null | undefined, postId: string, anonViewerId?: string | null, source?: string | null): Promise<void> {
    const uid = (userId ?? '').trim();
    const pid = (postId ?? '').trim();
    const anonId = sanitizeAnonViewerId(anonViewerId);
    if (!pid || (!uid && !anonId)) return;

    try {
      // Fetch post with visibility so we can enforce access (author always allowed)
      const post = await this.prisma.post.findFirst({
        where: { id: pid, deletedAt: null },
        select: { id: true, visibility: true, userId: true },
      });
      if (!post) return;

      // Authors can always view their own posts; everyone else must meet the tier requirement.
      if (uid && post.userId !== uid) {
        const viewer = await this.prisma.user.findFirst({
          where: { id: uid },
          select: { verifiedStatus: true, premium: true, premiumPlus: true },
        });
        if (!viewerCanAccessVisibility(post.visibility, viewer)) return;
      }
      if (!uid && post.visibility !== 'public') return;

      if (uid && anonId) {
        await this.prisma.viewerIdentity.upsert({
          where: { anonId },
          create: { anonId, userId: uid },
          update: { userId: uid },
        });
      }

      let weightedIncrement = 0;
      let viewerIncrement = 0;
      if (uid) {
        const now = new Date();
        const result = await this.prisma.$transaction(async (tx) => {
          const created = await tx.postView.createMany({
            data: [{ postId: pid, userId: uid }],
            skipDuplicates: true,
          });
          // Upgrade path: if the same browser had an anon record, consume it
          // so this identity is counted only once.
          const consumedAnonCount = anonId
            ? (
                await tx.postAnonView.deleteMany({
                  where: { postId: pid, anonId },
                })
              ).count
            : 0;

          let viewerIncrementLocal = 0;
          let weightedIncrementLocal = 0;
          if (created.count > 0) {
            viewerIncrementLocal = consumedAnonCount > 0 ? 0 : 1;
            weightedIncrementLocal = consumedAnonCount > 0 ? 0.5 : LOGGED_IN_VIEW_WEIGHT;
          }

          if (viewerIncrementLocal !== 0 || weightedIncrementLocal !== 0) {
            const updated = await tx.post.update({
              where: { id: pid },
              data: {
                viewerCount: { increment: viewerIncrementLocal },
                weightedViewCount: { increment: weightedIncrementLocal },
              },
              select: { viewerCount: true },
            });
            return { createdCount: created.count, viewerIncrementLocal, weightedIncrementLocal, viewerCount: updated.viewerCount };
          }

          const unchanged = await tx.post.findUnique({
            where: { id: pid },
            select: { viewerCount: true },
          });
          return { createdCount: created.count, viewerIncrementLocal, weightedIncrementLocal, viewerCount: unchanged?.viewerCount ?? 0 };
        });

        viewerIncrement = result.viewerIncrementLocal;
        weightedIncrement = result.weightedIncrementLocal;
        if (result.createdCount > 0) {
          this.posthog.capture(uid, 'post_viewed', {
            post_id: pid,
            source: (source ?? 'unknown').toString().slice(0, 80),
            viewer_type: 'user',
          });
        }

        if (viewerIncrement !== 0 || weightedIncrement !== 0) {
          void this.redis.del(breakdownCacheKey(pid)).catch(() => undefined);
          this.presenceRealtime.emitPostsLiveUpdated(pid, {
            postId: pid,
            version: now.toISOString(),
            reason: 'viewerCount',
            patch: { viewerCount: result.viewerCount },
          });
        }
        await this.notifications.markReadBySubject(uid, { postId: pid });
        return;
      } else if (anonId) {
        const linkedIdentity = await this.prisma.viewerIdentity.findUnique({
          where: { anonId },
          select: { userId: true },
        });
        if (linkedIdentity?.userId) {
          const alreadyViewedAsUser = await this.prisma.postView.findUnique({
            where: { postId_userId: { postId: pid, userId: linkedIdentity.userId } },
            select: { postId: true },
          });
          if (alreadyViewedAsUser) return;
        }

        const now = new Date();
        const created = await this.prisma.postAnonView.createMany({
          data: [{ postId: pid, anonId, lastViewedAt: now }],
          skipDuplicates: true,
        });
        if (created.count > 0) {
          viewerIncrement = 1;
          weightedIncrement = ANON_VIEW_WEIGHT;
        } else {
          const refreshed = await this.prisma.postAnonView.updateMany({
            where: { postId: pid, anonId, lastViewedAt: { lt: cutoffForAnonRecount(now) } },
            data: { lastViewedAt: now },
          });
          if (refreshed.count > 0) {
            viewerIncrement = 1;
            weightedIncrement = ANON_VIEW_WEIGHT;
          }
        }
      }
      if (weightedIncrement <= 0) return;

      // First unique view: increment the denormalized counter atomically.
      // For upgraded anon->user views, viewerIncrement is 0 while weighted is +0.5.
      const updated = await this.prisma.post.update({
        where: { id: pid },
        data: {
          viewerCount: { increment: viewerIncrement },
          weightedViewCount: { increment: weightedIncrement },
        },
        select: { viewerCount: true },
      });

      // Invalidate breakdown cache so the next hover fetch is fresh
      void this.redis.del(breakdownCacheKey(pid)).catch(() => undefined);

      // Push live update to all sockets subscribed to this post
      this.presenceRealtime.emitPostsLiveUpdated(pid, {
        postId: pid,
        version: new Date().toISOString(),
        reason: 'viewerCount',
        patch: { viewerCount: updated.viewerCount },
      });

    } catch (err) {
      this.logger.warn(`markViewed failed for postId=${pid} userId=${uid}: ${String(err)}`);
    }
  }

  /**
   * Batch version of markViewed. Silently ignores invalid/missing posts.
   * Caps at BATCH_MAX IDs to prevent abuse.
   */
  async markViewedBatch(
    userId: string | null | undefined,
    postIds: string[],
    anonViewerId?: string | null,
    source?: string | null,
  ): Promise<void> {
    const uid = (userId ?? '').trim();
    const anonId = sanitizeAnonViewerId(anonViewerId);
    if ((!uid && !anonId) || !Array.isArray(postIds) || postIds.length === 0) return;

    const ids = [...new Set(postIds.map((id) => (id ?? '').trim()).filter(Boolean))].slice(0, BATCH_MAX);
    if (ids.length === 0) return;

    // Fire-and-forget each; they handle their own error logging
    await Promise.all(ids.map((pid) => this.markViewed(uid || null, pid, anonId, source)));
  }

  /**
   * Returns a breakdown of viewers by tier (cached for BREAKDOWN_TTL_SECONDS).
   * premium: users with premium OR premiumPlus
   * verified: verifiedStatus != 'none' AND NOT (premium OR premiumPlus)
   * unverified: verifiedStatus == 'none' AND NOT (premium OR premiumPlus)
   */
  async getBreakdown(postId: string): Promise<PostViewBreakdown> {
    const pid = (postId ?? '').trim();

    return this.cache.getOrSetJson<PostViewBreakdown>({
      enabled: true,
      key: breakdownCacheKey(pid),
      ttlSeconds: BREAKDOWN_TTL_SECONDS,
      compute: async () => {
        const [rows, anonRows] = await Promise.all([
          this.prisma.$queryRaw<
            Array<{ premium: bigint; verified: bigint; unverified: bigint }>
          >`
            SELECT
              COUNT(*) FILTER (WHERE u.premium OR u."premiumPlus")                                        AS premium,
              COUNT(*) FILTER (WHERE u."verifiedStatus" != 'none' AND NOT (u.premium OR u."premiumPlus")) AS verified,
              COUNT(*) FILTER (WHERE u."verifiedStatus" = 'none'  AND NOT (u.premium OR u."premiumPlus")) AS unverified
            FROM "PostView" pv
            JOIN "User" u ON u.id = pv."userId"
            WHERE pv."postId" = ${pid}
          `,
          this.prisma.postAnonView.count({ where: { postId: pid } }),
        ]);

        const row = rows[0] ?? { premium: 0n, verified: 0n, unverified: 0n };
        const premium = Number(row.premium ?? 0);
        const verified = Number(row.verified ?? 0);
        const unverified = Number(row.unverified ?? 0);
        const guest = anonRows;

        return { premium, verified, unverified, guest, total: premium + verified + unverified + guest };
      },
    });
  }
}
