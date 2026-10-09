import { NotificationReadSubjectsService } from "../notifications";
import {
  incrementPostViewCounts,
  postViewCountsOn,
} from "../posts-read/post-transaction.commands";
import { Injectable, Logger, Inject } from "@nestjs/common";
import { PrismaService } from "../prisma/prisma.service";
import { CacheService } from "../redis/cache.service";
import { RedisService } from "../redis/redis.service";
import { PresenceRealtimeService } from "../presence/presence-realtime.service";
import { CacheInvalidationService } from "../redis/cache-invalidation.service";
import { PosthogService } from "../../common/posthog/posthog.service";
import type { PostViewAckDto } from "../../common/dto/view-ack.dto";
import {
  ANON_VIEW_WEIGHT,
  LOGGED_IN_VIEW_WEIGHT,
  VIEW_ROOM_EMIT_THROTTLE_MS,
  cutoffForAnonRecount,
  cutoffForLastSeenRefresh,
  cutoffForTotalViewRecount,
  sanitizeAnonViewerId,
} from "../views/view-tracking.utils";

import { PostsReadService } from "../posts-read/posts-read.service";
import { PostsWriteService } from "../posts-read/posts-write.service";
import {
  BATCH_MAX,
  breakdownCacheKey,
  normalizeViewSource,
  viewerCanAccessVisibility,
} from "./post-views.shared";
import { NOT_DELETED } from "../../common/prisma/where";
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
    @Inject(NotificationReadSubjectsService)
    private readonly notifications: Pick<
      NotificationReadSubjectsService,
      "markReadBySubject"
    >,
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
    const uid = (userId ?? "").trim();
    const pid = (postId ?? "").trim();
    const anonId = sanitizeAnonViewerId(anonViewerId);
    if (!pid || (!uid && !anonId)) return null;

    try {
      const post = await this.postsRead.findFirst({
        where: { id: pid, ...NOT_DELETED },
        select: { id: true, visibility: true, userId: true },
      });
      if (!post) return null;

      const viewer = uid
        ? await this.prisma.user.findFirst({
            where: { id: uid },
            select: {
              isBot: true,
              verifiedStatus: true,
              premium: true,
              premiumPlus: true,
            },
          })
        : null;
      if (viewer?.isBot) return null;

      if (
        uid &&
        post.userId !== uid &&
        !viewerCanAccessVisibility(post.visibility, viewer)
      )
        return null;
      if (!uid && post.visibility !== "public") return null;

      if (uid && anonId) {
        await this.prisma.viewerIdentity.upsert({
          where: { anonId },
          create: { anonId, userId: uid },
          update: { userId: uid },
        });
      }

      if (uid) {
        const ack = await this.markAuthenticatedView(
          uid,
          pid,
          anonId,
          source,
          opts,
        );
        if (ack) await this.recordOpen(uid, pid, null, source);
        return ack;
      }
      const ack = await this.markAnonView(pid, anonId as string);
      if (ack) await this.recordOpen(null, pid, anonId, source);
      return ack;
    } catch (err) {
      this.logger.warn(
        `markViewed failed for postId=${pid} userId=${uid}: ${String(err)}`,
      );
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
        data: [
          {
            postId: pid,
            userId: uid,
            lastSeenAt: now,
            seenCount: 1,
            impressionCount: 1,
            lastImpressionAt: now,
            lastSource,
          },
        ],
        skipDuplicates: true,
      });
      const anonOpen = anonId
        ? await tx.postAnonView.findUnique({
            where: { postId_anonId: { postId: pid, anonId } },
            select: { openCount: true, lastOpenedAt: true },
          })
        : null;
      const consumedAnonCount = anonId
        ? (await tx.postAnonView.deleteMany({ where: { postId: pid, anonId } }))
            .count
        : 0;
      if (consumedAnonCount && anonOpen)
        await this.mergeOpenHistory(tx, uid, pid, anonOpen);

      let viewerIncrementLocal = 0;
      let weightedIncrementLocal = 0;
      let totalIncrementLocal = 0;
      let lastSeenRefreshed = created.count > 0;
      if (created.count > 0) {
        viewerIncrementLocal = consumedAnonCount > 0 ? 0 : 1;
        weightedIncrementLocal =
          consumedAnonCount > 0 ? 0.5 : LOGGED_IN_VIEW_WEIGHT;
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

      if (
        viewerIncrementLocal !== 0 ||
        weightedIncrementLocal !== 0 ||
        totalIncrementLocal !== 0
      ) {
        const updated = await incrementPostViewCounts(tx, pid, {
          unique: viewerIncrementLocal,
          weighted: weightedIncrementLocal,
          total: totalIncrementLocal,
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

      const unchanged = await postViewCountsOn(tx, pid);
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
      this.posthog.capture(uid, "post_viewed", {
        post_id: pid,
        source: lastSource ?? "unknown",
        viewer_type: "user",
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
    if (
      !opts?.skipMarkRead &&
      (source !== "feed_scroll" ||
        (await this.postsRead.findFirst({
          where: { id: pid, kind: { not: "board" } },
          select: { id: true },
        })))
    ) {
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

  private async markAnonView(
    pid: string,
    anonId: string,
  ): Promise<PostViewAckDto | null> {
    const linkedIdentity = await this.prisma.viewerIdentity.findUnique({
      where: { anonId },
      select: { userId: true },
    });
    if (linkedIdentity?.userId) {
      const alreadyViewedAsUser = await this.prisma.postView.findUnique({
        where: {
          postId_userId: { postId: pid, userId: linkedIdentity.userId },
        },
        select: { postId: true },
      });
      if (alreadyViewedAsUser) {
        return this.markAuthenticatedView(
          linkedIdentity.userId,
          pid,
          anonId,
          "anon_linked",
        );
      }
    }

    const now = new Date();
    const created = await this.prisma.postAnonView.createMany({
      data: [
        {
          postId: pid,
          anonId,
          lastViewedAt: now,
          impressionCount: 1,
          lastImpressionAt: now,
        },
      ],
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
        where: {
          postId: pid,
          anonId,
          lastViewedAt: { lt: cutoffForAnonRecount(now) },
        },
        data: { lastViewedAt: now },
      });
      if (refreshed.count > 0) {
        weightedIncrement = ANON_VIEW_WEIGHT;
      }
      const impressed = await this.prisma.postAnonView.updateMany({
        where: {
          postId: pid,
          anonId,
          lastImpressionAt: { lt: cutoffForTotalViewRecount(now) },
        },
        data: {
          lastImpressionAt: now,
          impressionCount: { increment: 1 },
        },
      });
      if (impressed.count > 0) totalIncrement = 1;
    }

    if (
      viewerIncrement === 0 &&
      weightedIncrement <= 0 &&
      totalIncrement === 0
    ) {
      const unchanged = await this.postsRead.findUnique({
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

    const updated = await this.postsWrite.recordViewCounts(pid, {
      unique: viewerIncrement,
      weighted: weightedIncrement,
      total: totalIncrement,
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

  async mergeOpenHistory(
    tx: import("@prisma/client").Prisma.TransactionClient,
    uid: string,
    pid: string,
    history: { openCount: number; lastOpenedAt: Date | null },
  ) {
    if (history.openCount > 0)
      await tx.postView.updateMany({
        where: { userId: uid, postId: pid },
        data: { openCount: { increment: history.openCount } },
      });
    if (history.lastOpenedAt)
      await tx.postView.updateMany({
        where: {
          userId: uid,
          postId: pid,
          OR: [
            { lastOpenedAt: null },
            { lastOpenedAt: { lt: history.lastOpenedAt } },
          ],
        },
        data: { lastOpenedAt: history.lastOpenedAt },
      });
  }

  /** Detail opens have their own 30s gate: a preceding feed impression cannot swallow one. */
  async recordOpen(
    uid: string | null,
    pid: string,
    anonId: string | null,
    source?: string | null,
  ) {
    // permalink_engaged is retained for shipped Board clients; new clients send post_open.
    if (source !== "post_open" && source !== "permalink_engaged") return;
    if (!uid && anonId) {
      const linked = await this.prisma.viewerIdentity.findUnique({
        where: { anonId },
        select: { userId: true },
      });
      if (
        linked?.userId &&
        (await this.prisma.postView.findUnique({
          where: { postId_userId: { postId: pid, userId: linked.userId } },
          select: { postId: true },
        }))
      )
        uid = linked.userId;
    }
    const now = new Date();
    const where = {
      postId: pid,
      post: { kind: "board" as const },
      OR: [
        { lastOpenedAt: null },
        { lastOpenedAt: { lt: cutoffForTotalViewRecount(now) } },
      ],
    };
    const data = { lastOpenedAt: now, openCount: { increment: 1 } };
    const updated = uid
      ? await this.prisma.postView.updateMany({
          where: { ...where, userId: uid },
          data,
        })
      : anonId
        ? await this.prisma.postAnonView.updateMany({
            where: { ...where, anonId },
            data,
          })
        : null;
    if (updated?.count)
      this.posthog.capture(uid ?? anonId!, "board_thread_opened", {
        post_id: pid,
        viewer_type: uid ? "user" : "guest",
      });
  }

  async emitViewCounts(
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
      reason: opts.uniqueCounted ? "viewerCount" : "totalViewCount",
      patch: {
        viewerCount: opts.viewerCount,
        totalViewCount: opts.totalViewCount,
      },
    };
    if (opts.actorUserId && (opts.uniqueCounted || opts.totalCounted)) {
      this.presenceRealtime.emitPostsLiveUpdatedToUser(
        opts.actorUserId,
        payload,
      );
    }
    if (opts.uniqueCounted) {
      this.presenceRealtime.emitPostsLiveUpdated(postId, payload);
      return;
    }
    if (!opts.totalCounted) return;
    const shouldEmit = await this.redis.setString(
      `view-emit:post:${postId}`,
      "1",
      {
        ttlMs: VIEW_ROOM_EMIT_THROTTLE_MS,
        onlyIfAbsent: true,
      },
    );
    if (shouldEmit) {
      this.presenceRealtime.emitPostsLiveUpdated(postId, payload);
    }
  }

  async expandViewTargetIds(ids: string[]): Promise<string[]> {
    if (ids.length === 0) return [];

    const rows = await this.postsRead.findMany({
      where: { id: { in: ids }, ...NOT_DELETED },
      select: {
        id: true,
        kind: true,
        repostedPostId: true,
        quotedPostId: true,
      },
    });

    const out = new Set(ids);
    for (const row of rows) {
      if (row.kind === "repost" && row.repostedPostId)
        out.add(row.repostedPostId);
      if (row.quotedPostId) out.add(row.quotedPostId);
    }

    return [...out].slice(0, BATCH_MAX);
  }
}
