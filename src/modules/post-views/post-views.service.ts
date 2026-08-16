import { Injectable, Logger, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { CacheService } from '../redis/cache.service';
import { RedisService } from '../redis/redis.service';
import { PresenceRealtimeService } from '../presence/presence-realtime.service';
import { CacheInvalidationService } from '../redis/cache-invalidation.service';
import { PosthogService } from '../../common/posthog/posthog.service';
import { NotificationsService } from '../notifications/notifications.service';
import {
  ANON_VIEW_WEIGHT,
  LOGGED_IN_VIEW_WEIGHT,
  cutoffForAnonRecount,
  cutoffForLastSeenRefresh,
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

function normalizeViewSource(source: string | null | undefined): string | null {
  const value = (source ?? '').toString().trim().slice(0, 80);
  return value || null;
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
    private readonly cacheInvalidation: CacheInvalidationService,
    private readonly presenceRealtime: PresenceRealtimeService,
    private readonly posthog: PosthogService,
    private readonly notifications: NotificationsService,
  ) {}

  /**
   * Record that a user viewed a post. Unique viewerCount stays 1 per user.
   * Repeat authenticated views refresh lastSeenAt (and seenCount) after a short
   * buffer so For You can suppress recently re-seen posts on the next refresh.
   * Emits a WebSocket event if this is the first (unique) view.
   */
  async markViewed(
    userId: string | null | undefined,
    postId: string,
    anonViewerId?: string | null,
    source?: string | null,
    opts?: { skipMarkRead?: boolean },
  ): Promise<void> {
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

      // Fetch viewer for bot-exclusion and visibility checks. Bots never count as viewers.
      const viewer = uid
        ? await this.prisma.user.findFirst({
            where: { id: uid },
            select: { isBot: true, verifiedStatus: true, premium: true, premiumPlus: true },
          })
        : null;
      if (viewer?.isBot) return;

      // Authors can always view their own posts; everyone else must meet the tier requirement.
      if (uid && post.userId !== uid && !viewerCanAccessVisibility(post.visibility, viewer)) return;
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
        const lastSource = normalizeViewSource(source);
        const result = await this.prisma.$transaction(async (tx) => {
          const created = await tx.postView.createMany({
            data: [{ postId: pid, userId: uid, lastSeenAt: now, seenCount: 1, lastSource }],
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
          let lastSeenRefreshed = created.count > 0;
          if (created.count > 0) {
            viewerIncrementLocal = consumedAnonCount > 0 ? 0 : 1;
            weightedIncrementLocal = consumedAnonCount > 0 ? 0.5 : LOGGED_IN_VIEW_WEIGHT;
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
            return { createdCount: created.count, viewerIncrementLocal, weightedIncrementLocal, lastSeenRefreshed, viewerCount: updated.viewerCount };
          }

          const unchanged = await tx.post.findUnique({
            where: { id: pid },
            select: { viewerCount: true },
          });
          return { createdCount: created.count, viewerIncrementLocal, weightedIncrementLocal, lastSeenRefreshed, viewerCount: unchanged?.viewerCount ?? 0 };
        });

        viewerIncrement = result.viewerIncrementLocal;
        weightedIncrement = result.weightedIncrementLocal;
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

        if (viewerIncrement !== 0 || weightedIncrement !== 0) {
          void this.redis.del(breakdownCacheKey(pid)).catch(() => undefined);
          this.presenceRealtime.emitPostsLiveUpdated(pid, {
            postId: pid,
            version: now.toISOString(),
            reason: 'viewerCount',
            patch: { viewerCount: result.viewerCount },
          });
        }
        if (!opts?.skipMarkRead) {
          await this.notifications.markReadBySubject(uid, { postId: pid });
        }
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
            // Keep weighted engagement for trending, but do not increment unique viewerCount.
            // This preserves "people saw this" semantics for viewerCount/breakdown totals.
            viewerIncrement = 0;
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
   *
   * When a post embeds another (flat repost via `repostedPostId`, or quote via
   * `quotedPostId`), the embedded post is also marked viewed in the same batch
   * so preview visibility counts toward both posts without an extra HTTP round-trip.
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

    const expanded = await this.expandViewTargetIds(ids);

    // Fire-and-forget each view write; mark-read is batched once below.
    await Promise.all(
      expanded.map((pid) => this.markViewed(uid || null, pid, anonId, source, { skipMarkRead: true })),
    );
    if (uid) {
      await this.notifications.markReadBySubjects(uid, expanded);
    }
  }

  /**
   * Expand a batch of post IDs to also include embedded preview targets
   * (reposted original + quoted post). One query per batch; re-caps at BATCH_MAX.
   */
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

  /**
   * Returns a breakdown of viewers by tier (cached for BREAKDOWN_TTL_SECONDS).
   * premium: users with premium OR premiumPlus
   * verified: verifiedStatus != 'none' AND NOT (premium OR premiumPlus)
   * unverified: verifiedStatus == 'none' AND NOT (premium OR premiumPlus)
   */
  async getBreakdown(
    postId: string,
    viewerUserId?: string | null,
    options?: { fresh?: boolean },
  ): Promise<PostViewBreakdown> {
    const pid = (postId ?? '').trim();
    const uid = (viewerUserId ?? '').trim() || null;

    const post = await this.prisma.post.findFirst({
      where: { id: pid, deletedAt: null },
      select: { visibility: true, userId: true, viewerCount: true },
    });
    if (!post) throw new NotFoundException('Post not found.');

    // onlyMe posts expose their breakdown to the author only; all other visibility levels
    // expose the aggregate tier counts publicly (matching the viewerCount already shown in feeds).
    const isSelf = Boolean(uid && post.userId === uid);
    if (!isSelf && post.visibility === 'onlyMe') {
      throw new NotFoundException('Post not found.');
    }

    const computeBreakdown = async (): Promise<PostViewBreakdown> => {
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

      // Canonical total is the denormalized Post.viewerCount shown in feed rows/chips.
      // Derive guest as the remainder so breakdown always sums to the displayed total.
      const total = Math.max(0, Math.floor(Number(post.viewerCount ?? 0)));
      const guest = Math.max(0, total - (premium + verified + unverified));

      return { premium, verified, unverified, guest, total };
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
