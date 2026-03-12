import { Injectable, Logger } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { CacheService } from '../redis/cache.service';
import { RedisService } from '../redis/redis.service';
import { PresenceRealtimeService } from '../presence/presence-realtime.service';
import { PosthogService } from '../../common/posthog/posthog.service';

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
  ) {}

  /**
   * Record that a user viewed a post. Idempotent: multiple calls for the same
   * (userId, postId) pair are safe and will not double-count.
   * Emits a WebSocket event if this is the first (unique) view.
   */
  async markViewed(userId: string, postId: string): Promise<void> {
    const uid = (userId ?? '').trim();
    const pid = (postId ?? '').trim();
    if (!uid || !pid) return;

    try {
      // Fetch post with visibility so we can enforce access (author always allowed)
      const post = await this.prisma.post.findFirst({
        where: { id: pid, deletedAt: null },
        select: { id: true, visibility: true, userId: true },
      });
      if (!post) return;

      // Authors can always view their own posts; everyone else must meet the tier requirement
      if (post.userId !== uid) {
        const viewer = await this.prisma.user.findFirst({
          where: { id: uid },
          select: { verifiedStatus: true, premium: true, premiumPlus: true },
        });
        if (!viewerCanAccessVisibility(post.visibility, viewer)) return;
      }

      // Upsert: createMany with skipDuplicates is the idiomatic Prisma pattern
      const created = await this.prisma.postView.createMany({
        data: [{ postId: pid, userId: uid }],
        skipDuplicates: true,
      });

      if (created.count === 0) {
        // Already viewed — no-op
        return;
      }

      this.posthog.capture(uid, 'post_viewed', { post_id: pid });

      // First unique view: increment the denormalized counter atomically
      const updated = await this.prisma.post.update({
        where: { id: pid },
        data: { viewerCount: { increment: 1 } },
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
  async markViewedBatch(userId: string, postIds: string[]): Promise<void> {
    const uid = (userId ?? '').trim();
    if (!uid || !Array.isArray(postIds) || postIds.length === 0) return;

    const ids = [...new Set(postIds.map((id) => (id ?? '').trim()).filter(Boolean))].slice(0, BATCH_MAX);
    if (ids.length === 0) return;

    // Fire-and-forget each; they handle their own error logging
    await Promise.all(ids.map((pid) => this.markViewed(uid, pid)));
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
        const rows = await this.prisma.$queryRaw<
          Array<{ premium: bigint; verified: bigint; unverified: bigint }>
        >`
          SELECT
            COUNT(*) FILTER (WHERE u.premium OR u."premiumPlus")                                        AS premium,
            COUNT(*) FILTER (WHERE u."verifiedStatus" != 'none' AND NOT (u.premium OR u."premiumPlus")) AS verified,
            COUNT(*) FILTER (WHERE u."verifiedStatus" = 'none'  AND NOT (u.premium OR u."premiumPlus")) AS unverified
          FROM "PostView" pv
          JOIN "User" u ON u.id = pv."userId"
          WHERE pv."postId" = ${pid}
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
