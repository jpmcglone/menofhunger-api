import { Injectable, Logger, Inject, NotFoundException } from "@nestjs/common";
import { NotificationReadSubjectsService } from "../notifications";
import {
  incrementPostViewCountsBatch,
  postViewCountsBatchOn,
} from "../posts-read/post-transaction.commands";

import {
  viewerCanAccessVisibility,
  normalizeViewSource,
  breakdownCacheKey,
  BREAKDOWN_TTL_SECONDS,
  BATCH_MAX,
  type PostViewBreakdown,
} from "./post-views.shared";
import { PostViewsService } from "./post-views.service";
import { CacheInvalidationService } from "../redis/cache-invalidation.service";
import { CacheService } from "../redis/cache.service";
import { PosthogService } from "../../common/posthog/posthog.service";
import { PostsReadService } from "../posts-read/posts-read.service";
import { PrismaService } from "../prisma/prisma.service";
import { RedisService } from "../redis/redis.service";

import type { PostViewAckDto } from "../../common/dto/view-ack.dto";
import {
  ANON_VIEW_WEIGHT,
  LOGGED_IN_VIEW_WEIGHT,
  cutoffForAnonRecount,
  cutoffForLastSeenRefresh,
  cutoffForTotalViewRecount,
  sanitizeAnonViewerId,
} from "../views/view-tracking.utils";
import { NOT_DELETED } from "../../common/prisma/where";

@Injectable()
export class PostViewsBatchService {
  private readonly logger = new Logger(PostViewsBatchService.name);

  constructor(
    private readonly views: PostViewsService,
    private readonly cache: CacheService,
    private readonly cacheInvalidation: CacheInvalidationService,
    @Inject(NotificationReadSubjectsService)
    private readonly notifications: Pick<
      NotificationReadSubjectsService,
      "markReadBySubjects"
    >,
    private readonly posthog: PosthogService,
    private readonly postsRead: PostsReadService,
    private readonly prisma: PrismaService,
    private readonly redis: RedisService,
  ) {}

  async markViewedBatch(
    userId: string | null | undefined,
    postIds: string[],
    anonViewerId?: string | null,
    source?: string | null,
  ): Promise<PostViewAckDto[]> {
    const uid = (userId ?? "").trim();
    const anonId = sanitizeAnonViewerId(anonViewerId);
    if ((!uid && !anonId) || !Array.isArray(postIds) || postIds.length === 0)
      return [];

    const ids = [
      ...new Set(postIds.map((id) => (id ?? "").trim()).filter(Boolean)),
    ].slice(0, BATCH_MAX);
    if (ids.length === 0) return [];

    let expanded: string[];
    try {
      expanded = await this.views.expandViewTargetIds(ids);
    } catch (err) {
      this.logger.warn(`markViewedBatch expand failed: ${String(err)}`);
      return [];
    }
    if (uid) {
      const acks = await this.markAuthenticatedViewsBatch(
        uid,
        expanded,
        anonId,
        source,
      );
      // Embedded quotes receive impressions, but only explicitly opened IDs receive opens.
      await Promise.all(
        acks
          .filter((ack) => ids.includes(ack.id))
          .map((ack) => this.views.recordOpen(uid, ack.id, null, source)),
      );
      try {
        const readableIds = acks.map((ack) => ack.id);
        const readIds =
          source === "feed_scroll"
            ? (
                await this.postsRead.findMany({
                  where: { id: { in: readableIds }, kind: { not: "board" } },
                  select: { id: true },
                })
              ).map((post) => post.id)
            : readableIds;
        if (readIds.length)
          await this.notifications.markReadBySubjects(uid, readIds);
      } catch (err) {
        this.logger.warn(
          `markViewedBatch mark-read failed userId=${uid}: ${String(err)}`,
        );
      }
      return acks;
    }

    return this.markAnonymousViewsBatch(expanded, anonId!, ids, source);
  }

  async markAnonymousViewsBatch(
    postIds: string[],
    anonId: string,
    openedIds: string[],
    source?: string | null,
  ): Promise<PostViewAckDto[]> {
    try {
      const [posts, identity] = await Promise.all([
        this.postsRead.findMany({
          where: { id: { in: postIds }, ...NOT_DELETED, visibility: "public" },
          select: { id: true },
        }),
        this.prisma.viewerIdentity.findUnique({
          where: { anonId },
          select: { userId: true },
        }),
      ]);
      if (!posts.length) return [];
      const publicIds = posts.map((post) => post.id);
      const linkedViews = identity?.userId
        ? await this.prisma.postView.findMany({
            where: { userId: identity.userId, postId: { in: publicIds } },
            select: { postId: true },
          })
        : [];
      const linkedIds = new Set(linkedViews.map((row) => row.postId));
      const guestIds = publicIds.filter((id) => !linkedIds.has(id));
      const acks =
        identity?.userId && linkedIds.size
          ? await this.markAuthenticatedViewsBatch(
              identity.userId,
              [...linkedIds],
              anonId,
              "anon_linked",
            )
          : [];
      const now = new Date();
      if (guestIds.length) {
        const counted = await this.prisma.$transaction(async (tx) => {
          const created = await tx.postAnonView.createManyAndReturn({
            data: guestIds.map((postId) => ({
              postId,
              anonId,
              lastViewedAt: now,
              impressionCount: 1,
              lastImpressionAt: now,
            })),
            skipDuplicates: true,
            select: { postId: true },
          });
          const refreshed = await tx.postAnonView.updateManyAndReturn({
            where: {
              anonId,
              postId: { in: guestIds },
              lastViewedAt: { lt: cutoffForAnonRecount(now) },
            },
            data: { lastViewedAt: now },
            select: { postId: true },
          });
          const impressed = await tx.postAnonView.updateManyAndReturn({
            where: {
              anonId,
              postId: { in: guestIds },
              lastImpressionAt: { lt: cutoffForTotalViewRecount(now) },
            },
            data: { lastImpressionAt: now, impressionCount: { increment: 1 } },
            select: { postId: true },
          });
          const createdIds = new Set(created.map((row) => row.postId));
          const weightedIds = new Set(refreshed.map((row) => row.postId));
          const impressedIds = new Set(impressed.map((row) => row.postId));
          const groups = [
            { ids: [...createdIds], unique: true, weighted: true, total: true },
            {
              ids: [...weightedIds].filter((id) => impressedIds.has(id)),
              unique: false,
              weighted: true,
              total: true,
            },
            {
              ids: [...weightedIds].filter((id) => !impressedIds.has(id)),
              unique: false,
              weighted: true,
              total: false,
            },
            {
              ids: [...impressedIds].filter((id) => !weightedIds.has(id)),
              unique: false,
              weighted: false,
              total: true,
            },
          ];
          for (const group of groups) {
            if (!group.ids.length) continue;
            await incrementPostViewCountsBatch(tx, group.ids, {
              unique: group.unique ? 1 : 0,
              weighted: group.weighted ? ANON_VIEW_WEIGHT : 0,
              total: group.total ? 1 : 0,
            });
          }
          const counts = await postViewCountsBatchOn(tx, guestIds);
          return counts.map((post) => ({
            ...post,
            uniqueCounted: createdIds.has(post.id),
            totalCounted: createdIds.has(post.id) || impressedIds.has(post.id),
          }));
        });
        const changed = counted.filter(
          (ack) => ack.uniqueCounted || ack.totalCounted,
        );
        if (changed.length) {
          void this.redis
            .del(...changed.map((ack) => breakdownCacheKey(ack.id)))
            .catch(() => undefined);
          await Promise.all(
            changed.map((ack) => this.views.emitViewCounts(ack.id, ack)),
          );
        }
        acks.push(...counted);
      }
      // Only actual detail opens count, never embedded quote/repost impressions.
      if (source === "post_open" || source === "permalink_engaged") {
        const where = {
          postId: {
            in: acks
              .map((ack) => ack.id)
              .filter((id) => openedIds.includes(id)),
          },
          post: { kind: "board" as const },
          OR: [
            { lastOpenedAt: null },
            { lastOpenedAt: { lt: cutoffForTotalViewRecount(now) } },
          ],
        };
        const data = { lastOpenedAt: now, openCount: { increment: 1 } };
        const guestOpens = await this.prisma.postAnonView.updateManyAndReturn({
          where: { ...where, anonId },
          data,
          select: { postId: true },
        });
        for (const row of guestOpens)
          this.posthog.capture(anonId, "board_thread_opened", {
            post_id: row.postId,
            viewer_type: "guest",
          });
        if (identity?.userId && linkedIds.size) {
          const userOpens = await this.prisma.postView.updateManyAndReturn({
            where: {
              ...where,
              userId: identity.userId,
              postId: {
                in: [...linkedIds].filter((id) => openedIds.includes(id)),
              },
            },
            data,
            select: { postId: true },
          });
          for (const row of userOpens)
            this.posthog.capture(identity.userId, "board_thread_opened", {
              post_id: row.postId,
              viewer_type: "user",
            });
        }
      }
      return acks;
    } catch (err) {
      this.logger.warn(`markAnonymousViewsBatch failed: ${String(err)}`);
      return [];
    }
  }

  async markAuthenticatedViewsBatch(
    uid: string,
    postIds: string[],
    anonId: string | null,
    source?: string | null,
  ): Promise<PostViewAckDto[]> {
    try {
      const [posts, viewer] = await Promise.all([
        this.postsRead.findMany({
          where: { id: { in: postIds }, ...NOT_DELETED },
          select: {
            id: true,
            visibility: true,
            userId: true,
            viewerCount: true,
            totalViewCount: true,
          },
        }),
        this.prisma.user.findFirst({
          where: { id: uid },
          select: {
            isBot: true,
            verifiedStatus: true,
            premium: true,
            premiumPlus: true,
          },
        }),
      ]);
      if (viewer?.isBot) return [];

      const accessible = posts.filter(
        (post) =>
          post.userId === uid ||
          viewerCanAccessVisibility(post.visibility, viewer),
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
          : Promise.resolve(
              [] as Array<{
                postId: string;
                openCount: number;
                lastOpenedAt: Date | null;
              }>,
            ),
      ]);

      const existingByPostId = new Map(
        existingViews.map((row) => [row.postId, row]),
      );
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
        const impressed =
          toRefreshImpression.length > 0
            ? await tx.postView.updateManyAndReturn({
                where: {
                  userId: uid,
                  postId: { in: toRefreshImpression },
                  lastImpressionAt: { lt: impressionCutoff },
                },
                data: {
                  lastImpressionAt: now,
                  impressionCount: { increment: 1 },
                },
                select: { postId: true },
              })
            : [];
        if (anonId) {
          for (const anon of anonRows) {
            const consumed = await tx.postAnonView.deleteMany({
              where: { postId: anon.postId, anonId },
            });
            if (consumed.count)
              await this.views.mergeOpenHistory(tx, uid, anon.postId, anon);
          }
        }

        const createdIds = new Set(created.map((row) => row.postId));
        const firstNoAnon = [...createdIds].filter(
          (id) => !anonPostIds.has(id),
        );
        const firstConsumedAnon = [...createdIds].filter((id) =>
          anonPostIds.has(id),
        );
        const impressionOnly = impressed
          .map((row) => row.postId)
          .filter((id) => !createdIds.has(id));

        if (firstNoAnon.length > 0) {
          await incrementPostViewCountsBatch(tx, firstNoAnon, {
            unique: 1,
            weighted: LOGGED_IN_VIEW_WEIGHT,
            total: 1,
          });
        }
        if (firstConsumedAnon.length > 0) {
          await incrementPostViewCountsBatch(tx, firstConsumedAnon, {
            unique: 0,
            weighted: 0.5,
            total: 1,
          });
        }
        if (impressionOnly.length > 0) {
          await incrementPostViewCountsBatch(tx, impressionOnly, {
            unique: 0,
            weighted: 0,
            total: 1,
          });
        }

        return { created, impressionOnly };
      });

      const createdIds = new Set(counted.created.map((row) => row.postId));
      if (createdIds.size > 0 || toRefreshLastSeen.length > 0) {
        await this.cacheInvalidation.bumpForYouUser(uid).catch(() => undefined);
      }

      const incrementByPostId = new Map<
        string,
        { viewer: number; total: number }
      >();
      for (const id of createdIds) {
        incrementByPostId.set(id, {
          viewer: anonPostIds.has(id) ? 0 : 1,
          total: 1,
        });
      }
      for (const id of counted.impressionOnly) {
        if (!createdIds.has(id))
          incrementByPostId.set(id, { viewer: 0, total: 1 });
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
          this.posthog.capture(uid, "post_viewed", {
            post_id: post.id,
            source: lastSource ?? "unknown",
            viewer_type: "user",
          });
        }
        if (uniqueCounted || totalCounted) {
          breakdownKeys.push(breakdownCacheKey(post.id));
          emitJobs.push(
            this.views.emitViewCounts(post.id, {
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
      this.logger.warn(
        `markAuthenticatedViewsBatch failed userId=${uid}: ${String(err)}`,
      );
      return [];
    }
  }

  async getBreakdown(
    postId: string,
    viewerUserId?: string | null,
    options?: { fresh?: boolean },
  ): Promise<PostViewBreakdown> {
    const pid = (postId ?? "").trim();
    const uid = (viewerUserId ?? "").trim() || null;

    const post = await this.postsRead.findFirst({
      where: { id: pid, ...NOT_DELETED },
      select: {
        visibility: true,
        userId: true,
        viewerCount: true,
        totalViewCount: true,
      },
    });
    if (!post) throw new NotFoundException("Post not found.");

    const isSelf = Boolean(uid && post.userId === uid);
    if (!isSelf && post.visibility === "onlyMe") {
      throw new NotFoundException("Post not found.");
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
      const totalViewCount = Math.max(
        0,
        Math.floor(Number(post.totalViewCount ?? total)),
      );
      const guest = Math.max(0, total - (premium + verified + unverified));
      const guestTotal = Math.max(
        0,
        totalViewCount - (premiumTotal + verifiedTotal + unverifiedTotal),
      );

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
