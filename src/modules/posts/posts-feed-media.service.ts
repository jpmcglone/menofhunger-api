import {
  ForbiddenException,
  Injectable,
  NotFoundException,
} from "@nestjs/common";
import {Prisma} from "@prisma/client";
import type {
  PostMediaKind,
  PostVisibility,
} from "@prisma/client";
import {PrismaService} from "../prisma/prisma.service";
import {
  ViewerContextService,
} from "../viewer/viewer-context.service";
import {createdAtIdCursorWhere} from "../../common/pagination/created-at-id-cursor";
import {
  MENTION_USER_SELECT,
  USER_LIST_SELECT,
} from "../../common/prisma-selects/user.select";
import {
  toPostAuthorDtoFromFeedRow,
  type PostAuthorDto,
} from "../../common/dto/post.dto";
import {POSTS_RANKING} from "./posts-ranking.config";
import {
  excludeCommunityGroupPostsWhere,
  notDeletedWhere,
} from "./posts-query-builders";
import {
  feedPostInclude,
  type FeedPost,
  type PostCounts,
} from "./posts-feed.types";
import {PostsViewerEnrichmentService} from "./posts-viewer-enrichment.service";
import {
  totalUserPostsWhere,
} from "../../common/content-counts";
import {PostsFeedAccessService} from "./posts-feed-access.service";
import {PostsRankingService} from "./posts-ranking.service";
import {AppConfigService} from "../app/app-config.service";
import {PostsFeedListingsService} from "./posts-feed-listings.service";

@Injectable()
export class PostsFeedMediaService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly viewerContextService: ViewerContextService,
    private readonly enrichment: PostsViewerEnrichmentService,
    private readonly access: PostsFeedAccessService,
    private readonly ranking: PostsRankingService,
    private readonly appConfig: AppConfigService,
    private readonly listings: PostsFeedListingsService,
  ) {}
  async listForUsername(params: {
    viewerUserId: string | null;
    username: string;
    limit: number;
    cursor: string | null;
    visibility: "all" | PostVisibility;
    includeCounts: boolean;
    sort: "new" | "popular";
    topLevelOnly?: boolean;
    /** When true, include posts of all visibility tiers.
     *  Posts the viewer cannot access are returned with viewerCanAccess=false and stripped body/media. */
    includeRestricted?: boolean;
  }) {
    const {
      viewerUserId,
      username,
      limit,
      cursor,
      visibility,
      includeCounts,
      sort,
    } = params;
    const normalized = (username ?? "").trim();
    if (!normalized) throw new NotFoundException("User not found.");

    const user = await this.prisma.user.findFirst({
      where: { username: { equals: normalized, mode: "insensitive" } },
      select: { id: true },
    });
    if (!user) throw new NotFoundException("User not found.");

    const viewer = await this.viewerContextService.getViewer(viewerUserId);

    const isSelf = Boolean(viewer && viewer.id === user.id);

    const counts: PostCounts | null = includeCounts
      ? await (async () => {
          const grouped = await this.prisma.post.groupBy({
            by: ["visibility"],
            where: totalUserPostsWhere(user.id),
            _count: { _all: true },
          });

          const out: PostCounts = {
            all: 0,
            public: 0,
            verifiedOnly: 0,
            premiumOnly: 0,
          };
          for (const g of grouped) {
            const n = g._count._all;
            out.all += n;
            if (g.visibility === "public") out.public = n;
            if (g.visibility === "verifiedOnly") out.verifiedOnly = n;
            if (g.visibility === "premiumOnly") out.premiumOnly = n;
          }
          return out;
        })()
      : null;

    const allowed = isSelf
      ? (["public", "verifiedOnly", "premiumOnly"] as PostVisibility[])
      : this.enrichment.allowedVisibilitiesForViewer(viewer);

    if (!params.includeRestricted) {
      if (visibility === "verifiedOnly" && !isSelf) {
        if (!viewer || viewer.verifiedStatus === "none")
          throw new ForbiddenException("Verify to view verified-only posts.");
      }
      if (visibility === "premiumOnly" && !isSelf) {
        if (!viewer || !this.viewerContextService.isPremium(viewer)) {
          throw new ForbiddenException(
            "Upgrade to premium to view premium-only posts.",
          );
        }
      }
    }

    const topLevelFilter: Prisma.PostWhereInput = params.topLevelOnly
      ? { parentId: null }
      : {};

    // When includeRestricted=true, omit visibility filter so all tiers are returned.
    const allVisibilities: PostVisibility[] = [
      "public",
      "verifiedOnly",
      "premiumOnly",
    ];
    const effectiveAllowed = params.includeRestricted
      ? allVisibilities
      : allowed;

    const baseWhere =
      params.includeRestricted || visibility === "all"
        ? ({
            userId: user.id,
            visibility: { in: effectiveAllowed },
            ...notDeletedWhere(),
            ...excludeCommunityGroupPostsWhere(),
            ...topLevelFilter,
          } as Prisma.PostWhereInput)
        : ({
            userId: user.id,
            visibility,
            ...notDeletedWhere(),
            ...excludeCommunityGroupPostsWhere(),
            ...topLevelFilter,
          } as Prisma.PostWhereInput);

    if (sort === "popular") {
      // Trending for profile: same boost and bookmark scoring as the home feed, scoped to this user.
      const visibilitiesForQuery: PostVisibility[] =
        visibility === "all"
          ? allowed
          : visibility === "public"
            ? (["public"] as PostVisibility[])
            : ([visibility] as PostVisibility[]);
      const visibilitiesForQuerySql = visibilitiesForQuery.map(
        (v) => Prisma.sql`${v}::"PostVisibility"`,
      );

      const decoded = this.access.decodePopularCursor(cursor);
      const asOf = new Date();
      const asOfMs = asOf.getTime();
      const lookbackMs =
        POSTS_RANKING.popularLookbackDays * 24 * 60 * 60 * 1000;
      const minCreatedAt = new Date(asOfMs - lookbackMs);

      if (!decoded) {
        const staleBefore = new Date(asOfMs - POSTS_RANKING.boostScoreTtlMs);
        const warmup = await this.prisma.post.findMany({
          where: {
            AND: [
              { userId: user.id },
              ...(params.topLevelOnly ? [{ parentId: null }] : []),
              { visibility: { in: visibilitiesForQuery } },
              notDeletedWhere(),
              excludeCommunityGroupPostsWhere(),
              { createdAt: { gte: minCreatedAt } },
              { boostCount: { gt: 0 } },
              {
                OR: [
                  { boostScoreUpdatedAt: null },
                  { boostScoreUpdatedAt: { lt: staleBefore } },
                ],
              },
            ],
          },
          orderBy: [
            { boostCount: "desc" },
            { createdAt: "desc" },
            { id: "desc" },
          ],
          take: POSTS_RANKING.popularWarmupTake,
          select: { id: true },
        });
        await this.ranking.ensureBoostScoresFresh(warmup.map((p) => p.id));
      }

      const snapshotAsOf = decoded ? asOf : new Date();
      const snapshotMinCreatedAt = new Date(
        snapshotAsOf.getTime() - lookbackMs,
      );

      const cursorCreatedAt = decoded ? new Date(decoded.createdAt) : null;
      const cursorScore = decoded?.score ?? null;
      const cursorId = decoded?.id ?? null;

      const rows = await this.prisma.$queryRaw<
        Array<{ id: string; createdAt: Date; score: number }>
      >(Prisma.sql`
        WITH
        comment_scores AS (
          SELECT
            p."parentId" as "postId",
            CAST(
              SUM(
                POWER(
                  0.5,
                  GREATEST(
                    0,
                    EXTRACT(EPOCH FROM (${snapshotAsOf}::timestamptz - p."createdAt"))
                  ) / ${POSTS_RANKING.popularHalfLifeSeconds}
                )
              ) AS DOUBLE PRECISION
            ) as "commentScore"
          FROM "Post" p
          WHERE
            p."parentId" IS NOT NULL
            AND p."deletedAt" IS NULL
            AND p."createdAt" >= ${snapshotMinCreatedAt}
          GROUP BY p."parentId"
        ),
        scored AS (
          SELECT
            p."id" as "id",
            p."createdAt" as "createdAt",
            CAST(
              (
                -- boostScore already halves each boost every 24 hours.
                CASE
                WHEN p."boostScore" IS NULL OR p."boostScoreUpdatedAt" IS NULL THEN 0
                ELSE p."boostScore"
                END
              )
              +
              (
                (p."bookmarkCount"::DOUBLE PRECISION) * 0.5 * POWER(
                  0.5,
                  GREATEST(
                    0,
                    EXTRACT(EPOCH FROM (${snapshotAsOf}::timestamptz - p."createdAt"))
                  ) / ${POSTS_RANKING.popularHalfLifeSeconds}
                )
              )
              +
              (
                -- Reposts signal content spread / virality; decayed like bookmarks.
                (p."repostCount"::DOUBLE PRECISION) * ${POSTS_RANKING.popularRepostScoreWeight} * POWER(
                  0.5,
                  GREATEST(
                    0,
                    EXTRACT(EPOCH FROM (${snapshotAsOf}::timestamptz - p."createdAt"))
                  ) / ${POSTS_RANKING.popularHalfLifeSeconds}
                )
              )
              +
              (
                -- A flat-repost row is authored feed activity by the reposter.
                CASE WHEN p."kind" = 'repost' THEN ${POSTS_RANKING.popularRepostScoreWeight} ELSE 0 END
                * POWER(
                  0.5,
                  GREATEST(
                    0,
                    EXTRACT(EPOCH FROM (${snapshotAsOf}::timestamptz - p."createdAt"))
                  ) / ${POSTS_RANKING.popularHalfLifeSeconds}
                )
              )
              +
              (
                (COALESCE(cs."commentScore", 0)::DOUBLE PRECISION) * ${POSTS_RANKING.commentScoreWeight}
              )
              +
              (
                CASE
                  WHEN u."pinnedPostId" = p."id" THEN
                    (CASE WHEN u."premium" THEN ${POSTS_RANKING.pinScorePremium} WHEN u."verifiedStatus" <> 'none' THEN ${POSTS_RANKING.pinScoreVerified} ELSE ${POSTS_RANKING.pinScoreBase} END)
                    * POWER(
                      0.5,
                      GREATEST(0, EXTRACT(EPOCH FROM (${snapshotAsOf}::timestamptz - p."createdAt"))) / ${POSTS_RANKING.popularHalfLifeSeconds}
                    )
                  ELSE 0
                END
              )
              * (
                1 + LEAST(
                  ${POSTS_RANKING.popularEngagementRateCap},
                  ${POSTS_RANKING.popularEngagementRateWeight} * (
                    (
                      CASE WHEN p."boostScore" IS NULL OR p."boostScoreUpdatedAt" IS NULL THEN 0
                      ELSE p."boostScore" END
                    )
                    +
                    ((p."bookmarkCount"::DOUBLE PRECISION) * 0.5 * POWER(0.5, GREATEST(0, EXTRACT(EPOCH FROM (${snapshotAsOf}::timestamptz - p."createdAt")) / ${POSTS_RANKING.popularHalfLifeSeconds})))
                    +
                    ((p."repostCount"::DOUBLE PRECISION) * ${POSTS_RANKING.popularRepostScoreWeight} * POWER(0.5, GREATEST(0, EXTRACT(EPOCH FROM (${snapshotAsOf}::timestamptz - p."createdAt")) / ${POSTS_RANKING.popularHalfLifeSeconds})))
                    +
                    ((COALESCE(cs."commentScore", 0)::DOUBLE PRECISION) * ${POSTS_RANKING.commentScoreWeight})
                  ) / GREATEST((p."weightedViewCount" + ${POSTS_RANKING.popularEngagementRateK})::DOUBLE PRECISION, ${POSTS_RANKING.popularEngagementRateK}::DOUBLE PRECISION)
                )
              )
              AS DOUBLE PRECISION
            ) as "score"
          FROM "Post" p
          LEFT JOIN "User" u ON u."id" = p."userId"
          LEFT JOIN comment_scores cs ON cs."postId" = p."id"
          WHERE
            p."deletedAt" IS NULL
            AND p."communityGroupId" IS NULL AND p."boardOnly" = false
            ${params.topLevelOnly ? Prisma.sql`AND p."parentId" IS NULL` : Prisma.sql``}
            AND p."createdAt" >= ${snapshotMinCreatedAt}
            AND p."userId" = ${user.id}
            AND (u."bannedAt" IS NULL)
            AND p."visibility" IN (${Prisma.join(visibilitiesForQuerySql)})
        )
        SELECT "id", "createdAt", "score"
        FROM scored
        WHERE
          ${
            decoded && cursorCreatedAt && cursorScore != null && cursorId
              ? Prisma.sql`
                (
                  "score" < ${cursorScore}
                  OR (
                    "score" = ${cursorScore}
                    AND (
                      "createdAt" < ${cursorCreatedAt}
                      OR ("createdAt" = ${cursorCreatedAt} AND "id" < ${cursorId})
                    )
                  )
                )
              `
              : Prisma.sql`TRUE`
          }
        ORDER BY "score" DESC, "createdAt" DESC, "id" DESC
        LIMIT ${limit + 1}
      `);

      const sliceRows = rows.slice(0, limit);
      const ids = sliceRows.map((r) => r.id);
      const nextRow =
        rows.length > limit ? (sliceRows[sliceRows.length - 1] ?? null) : null;

      const posts = ids.length
        ? await this.prisma.post.findMany({
            where: { id: { in: ids } },
            include: feedPostInclude,
          })
        : [];
      const byId = new Map(posts.map((p) => [p.id, p] as const));
      const ordered = ids
        .map((id) => byId.get(id))
        .filter((p): p is (typeof posts)[number] => Boolean(p));

      const nextCursor =
        rows.length > limit && nextRow
          ? this.access.encodePopularCursor({
              score: nextRow.score,
              createdAt: nextRow.createdAt.toISOString(),
              id: nextRow.id,
            })
          : null;

      const scoreByPostId = new Map<string, number>(
        sliceRows.map((r) => [r.id, r.score]),
      );
      return { posts: ordered, nextCursor, counts, scoreByPostId };
    }

    const cursorWhere = await createdAtIdCursorWhere({
      cursor,
      lookup: async (id) =>
        await this.prisma.post.findUnique({
          where: { id },
          select: { id: true, createdAt: true },
        }),
    });

    const posts = await this.prisma.post.findMany({
      where: { AND: [baseWhere, ...(cursorWhere ? [cursorWhere] : [])] },
      include: feedPostInclude,
      orderBy: [{ createdAt: "desc" }, { id: "desc" }],
      take: limit + 1,
    });

    const slice = posts.slice(0, limit);
    const nextCursor =
      posts.length > limit ? (slice[slice.length - 1]?.id ?? null) : null;

    return { posts: slice, nextCursor, counts };
  }

  async listMediaForUsername(params: {
    viewerUserId: string | null;
    username: string;
    limit: number;
    cursor: string | null;
    visibility: "all" | PostVisibility;
    sort: "new" | "trending";
    includeRestricted?: boolean;
  }) {
    const {
      viewerUserId,
      username,
      limit,
      cursor,
      visibility,
      sort,
      includeRestricted,
    } = params;
    const normalized = (username ?? "").trim();
    if (!normalized) throw new NotFoundException("User not found.");

    const user = await this.prisma.user.findFirst({
      where: { username: { equals: normalized, mode: "insensitive" } },
      select: { id: true },
    });
    if (!user) throw new NotFoundException("User not found.");

    const viewer = await this.viewerContextService.getViewer(viewerUserId);
    const isSelf = Boolean(viewer && viewer.id === user.id);
    const allowed = isSelf
      ? (["public", "verifiedOnly", "premiumOnly"] as PostVisibility[])
      : this.enrichment.allowedVisibilitiesForViewer(viewer);

    // When includeRestricted, fetch all tiers and compute access per item.
    // When a specific visibility is requested via filter, honour it even in restricted mode.
    const allVisibilities: PostVisibility[] = [
      "public",
      "verifiedOnly",
      "premiumOnly",
    ];
    const visibilityFilter: PostVisibility[] = includeRestricted
      ? visibility !== "all"
        ? [visibility as PostVisibility]
        : allVisibilities
      : visibility === "all"
        ? allowed
        : allowed.includes(visibility as PostVisibility)
          ? [visibility as PostVisibility]
          : [];

    const r2BaseUrl = this.appConfig.r2()?.publicBaseUrl ?? null;

    // Trending sort: join through post.trendingScore. Use numeric offset cursor
    // (encoded as base64) because score order is volatile and ID-lt breaks pages.
    const offset =
      sort === "trending" && cursor
        ? (() => {
            try {
              return (
                parseInt(Buffer.from(cursor, "base64").toString("utf8"), 10) ||
                0
              );
            } catch {
              return 0;
            }
          })()
        : 0;

    const baseWhere: Prisma.PostMediaWhereInput = {
      kind: { in: ["image", "video"] },
      source: "upload",
      deletedAt: null,
      post: {
        userId: user.id,
        deletedAt: null,
        communityGroupId: null,
        boardOnly: false,
        visibility: { in: visibilityFilter },
      },
    };

    type MediaRow = {
      id: string;
      kind: PostMediaKind;
      r2Key: string | null;
      thumbnailR2Key: string | null;
      width: number | null;
      height: number | null;
      durationSeconds: number | null;
      postId: string;
      post: { visibility: PostVisibility };
    };
    let mediaRows: MediaRow[];

    if (sort === "trending") {
      // Include all media (including zero/unscored posts), but rank by parent post score.
      // Unscored/null scores sort to the bottom so "trending" remains score-first.
      mediaRows = await this.prisma.postMedia.findMany({
        where: baseWhere,
        orderBy: [
          { post: { trendingScore: { sort: "desc", nulls: "last" } } },
          { post: { boostCount: "desc" } },
          { post: { bookmarkCount: "desc" } },
          { post: { repostCount: "desc" } },
          { post: { commentCount: "desc" } },
          { post: { createdAt: "desc" } },
          { id: "desc" },
        ],
        skip: offset,
        take: limit + 1,
        select: {
          id: true,
          kind: true,
          r2Key: true,
          thumbnailR2Key: true,
          width: true,
          height: true,
          durationSeconds: true,
          postId: true,
          post: { select: { visibility: true } },
        },
      });
    } else {
      mediaRows = await this.prisma.postMedia.findMany({
        where: { ...baseWhere, ...(cursor ? { id: { lt: cursor } } : {}) },
        orderBy: [{ createdAt: "desc" }, { id: "desc" }],
        take: limit + 1,
        select: {
          id: true,
          kind: true,
          r2Key: true,
          thumbnailR2Key: true,
          width: true,
          height: true,
          durationSeconds: true,
          postId: true,
          post: { select: { visibility: true } },
        },
      });
    }

    const hasMore = mediaRows.length > limit;
    const items = hasMore ? mediaRows.slice(0, limit) : mediaRows;

    let nextCursor: string | null = null;
    if (hasMore) {
      if (sort === "trending") {
        nextCursor = Buffer.from(String(offset + limit)).toString("base64");
      } else {
        nextCursor = items[items.length - 1]?.id ?? null;
      }
    }

    return {
      items: items.map((m) => {
        const vis = m.post.visibility as PostVisibility;
        const viewerCanAccess = includeRestricted
          ? isSelf || allowed.includes(vis)
          : true;
        return {
          id: m.id,
          postId: m.postId,
          kind: m.kind as "image" | "video",
          url: r2BaseUrl && m.r2Key ? `${r2BaseUrl}/${m.r2Key}` : null,
          thumbnailUrl:
            r2BaseUrl && m.thumbnailR2Key
              ? `${r2BaseUrl}/${m.thumbnailR2Key}`
              : null,
          width: m.width,
          height: m.height,
          durationSeconds: m.durationSeconds ?? null,
          visibility: vis,
          viewerCanAccess,
        };
      }),
      nextCursor,
    };
  }

  // ─── Community group media grid ───────────────────────────────────────────

  async listMediaForGroupsHub(params: {
    viewerUserId: string;
    limit: number;
    cursor: string | null;
    sort: "new" | "trending";
  }) {
    const { viewerUserId, limit, cursor, sort } = params;
    const groupIds =
      await this.listings.listActiveCommunityGroupIdsForUser(viewerUserId);
    if (!groupIds.length) return { items: [], nextCursor: null };

    const r2BaseUrl = this.appConfig.r2()?.publicBaseUrl ?? null;

    const viewer = await this.viewerContextService.getViewer(viewerUserId);
    const allowedVisibilities =
      this.enrichment.allowedVisibilitiesForViewer(viewer);

    const baseWhere: Prisma.PostMediaWhereInput = {
      kind: { in: ["image", "video"] },
      source: "upload",
      deletedAt: null,
      post: {
        communityGroupId: { in: groupIds },
        deletedAt: null,
        visibility: { in: allowedVisibilities },
      },
    };

    type MediaRow = {
      id: string;
      kind: PostMediaKind;
      r2Key: string | null;
      thumbnailR2Key: string | null;
      width: number | null;
      height: number | null;
      durationSeconds: number | null;
      postId: string;
    };

    let mediaRows: MediaRow[];

    const offset =
      sort === "trending" && cursor
        ? (() => {
            try {
              return (
                parseInt(Buffer.from(cursor, "base64").toString("utf8"), 10) ||
                0
              );
            } catch {
              return 0;
            }
          })()
        : 0;

    if (sort === "trending") {
      mediaRows = await this.prisma.postMedia.findMany({
        where: baseWhere,
        orderBy: [
          { post: { trendingScore: { sort: "desc", nulls: "last" } } },
          { post: { boostCount: "desc" } },
          { post: { bookmarkCount: "desc" } },
          { post: { repostCount: "desc" } },
          { post: { commentCount: "desc" } },
          { post: { createdAt: "desc" } },
          { id: "desc" },
        ],
        skip: offset,
        take: limit + 1,
        select: {
          id: true,
          kind: true,
          r2Key: true,
          thumbnailR2Key: true,
          width: true,
          height: true,
          durationSeconds: true,
          postId: true,
        },
      });
    } else {
      mediaRows = await this.prisma.postMedia.findMany({
        where: { ...baseWhere, ...(cursor ? { id: { lt: cursor } } : {}) },
        orderBy: [{ createdAt: "desc" }, { id: "desc" }],
        take: limit + 1,
        select: {
          id: true,
          kind: true,
          r2Key: true,
          thumbnailR2Key: true,
          width: true,
          height: true,
          durationSeconds: true,
          postId: true,
        },
      });
    }

    const hasMore = mediaRows.length > limit;
    const items = hasMore ? mediaRows.slice(0, limit) : mediaRows;

    let nextCursor: string | null = null;
    if (hasMore) {
      if (sort === "trending") {
        nextCursor = Buffer.from(String(offset + limit)).toString("base64");
      } else {
        nextCursor = items[items.length - 1]?.id ?? null;
      }
    }

    return {
      items: items.map((m) => ({
        id: m.id,
        postId: m.postId,
        kind: m.kind as "image" | "video",
        url: r2BaseUrl && m.r2Key ? `${r2BaseUrl}/${m.r2Key}` : null,
        thumbnailUrl:
          r2BaseUrl && m.thumbnailR2Key
            ? `${r2BaseUrl}/${m.thumbnailR2Key}`
            : null,
        width: m.width,
        height: m.height,
        durationSeconds: m.durationSeconds ?? null,
      })),
      nextCursor,
    };
  }

  async listMediaForCommunityGroup(params: {
    viewerUserId: string;
    groupId: string;
    limit: number;
    cursor: string | null;
    sort: "new" | "trending";
  }) {
    const { viewerUserId, groupId, limit, cursor, sort } = params;
    await this.listings.assertCanReadCommunityGroup(viewerUserId, groupId);

    const r2BaseUrl = this.appConfig.r2()?.publicBaseUrl ?? null;

    const baseWhere: Prisma.PostMediaWhereInput = {
      kind: { in: ["image", "video"] },
      source: "upload",
      deletedAt: null,
      post: {
        communityGroupId: groupId,
        deletedAt: null,
      },
    };

    type MediaRow = {
      id: string;
      kind: PostMediaKind;
      r2Key: string | null;
      thumbnailR2Key: string | null;
      width: number | null;
      height: number | null;
      durationSeconds: number | null;
      postId: string;
    };

    let mediaRows: MediaRow[];

    const offset =
      sort === "trending" && cursor
        ? (() => {
            try {
              return (
                parseInt(Buffer.from(cursor, "base64").toString("utf8"), 10) ||
                0
              );
            } catch {
              return 0;
            }
          })()
        : 0;

    if (sort === "trending") {
      mediaRows = await this.prisma.postMedia.findMany({
        where: baseWhere,
        orderBy: [
          { post: { trendingScore: { sort: "desc", nulls: "last" } } },
          { post: { boostCount: "desc" } },
          { post: { bookmarkCount: "desc" } },
          { post: { repostCount: "desc" } },
          { post: { commentCount: "desc" } },
          { post: { createdAt: "desc" } },
          { id: "desc" },
        ],
        skip: offset,
        take: limit + 1,
        select: {
          id: true,
          kind: true,
          r2Key: true,
          thumbnailR2Key: true,
          width: true,
          height: true,
          durationSeconds: true,
          postId: true,
        },
      });
    } else {
      mediaRows = await this.prisma.postMedia.findMany({
        where: { ...baseWhere, ...(cursor ? { id: { lt: cursor } } : {}) },
        orderBy: [{ createdAt: "desc" }, { id: "desc" }],
        take: limit + 1,
        select: {
          id: true,
          kind: true,
          r2Key: true,
          thumbnailR2Key: true,
          width: true,
          height: true,
          durationSeconds: true,
          postId: true,
        },
      });
    }

    const hasMore = mediaRows.length > limit;
    const items = hasMore ? mediaRows.slice(0, limit) : mediaRows;

    let nextCursor: string | null = null;
    if (hasMore) {
      if (sort === "trending") {
        nextCursor = Buffer.from(String(offset + limit)).toString("base64");
      } else {
        nextCursor = items[items.length - 1]?.id ?? null;
      }
    }

    return {
      items: items.map((m) => ({
        id: m.id,
        postId: m.postId,
        kind: m.kind as "image" | "video",
        url: r2BaseUrl && m.r2Key ? `${r2BaseUrl}/${m.r2Key}` : null,
        thumbnailUrl:
          r2BaseUrl && m.thumbnailR2Key
            ? `${r2BaseUrl}/${m.thumbnailR2Key}`
            : null,
        width: m.width,
        height: m.height,
        durationSeconds: m.durationSeconds ?? null,
      })),
      nextCursor,
    };
  }

  /**
   * Cursor-paginated list of users who flat-reposted a post.
   * Ordered newest-repost-first. Soft-deleted reposts are excluded.
   */
  async listReposters(params: {
    viewerUserId: string | null;
    postId: string;
    limit: number;
    cursor: string | null;
  }): Promise<{ authors: PostAuthorDto[]; nextCursor: string | null }> {
    const { viewerUserId, postId, limit, cursor } = params;

    const post = await this.prisma.post.findFirst({
      where: { id: postId, deletedAt: null },
      select: {
        id: true,
        visibility: true,
        userId: true,
        communityGroupId: true,
      },
    });
    if (!post) throw new NotFoundException("Post not found.");

    const viewer = await this.viewerContextService.getViewer(viewerUserId);
    const allowed = this.enrichment.allowedVisibilitiesForViewer(viewer);
    if (!allowed.includes(post.visibility))
      throw new NotFoundException("Post not found.");

    // Enforce group membership — non-members must not enumerate reposters of a private group post.
    try {
      await this.access.assertReadableCommunityGroupPost(post, viewerUserId, viewer);
    } catch {
      throw new NotFoundException("Post not found.");
    }

    const reposts = await this.prisma.post.findMany({
      where: {
        kind: "repost",
        repostedPostId: postId,
        deletedAt: null,
        ...(cursor ? { createdAt: { lt: new Date(cursor) } } : {}),
      },
      orderBy: { createdAt: "desc" },
      take: limit + 1,
      include: { user: { select: USER_LIST_SELECT } },
    });

    const hasMore = reposts.length > limit;
    const page = hasMore ? reposts.slice(0, limit) : reposts;
    const r2BaseUrl = this.appConfig.r2()?.publicBaseUrl ?? null;
    const authors = page
      .map((r) => toPostAuthorDtoFromFeedRow(r as any, r2BaseUrl))
      .filter((a): a is PostAuthorDto => a !== null);
    const nextCursor = hasMore
      ? page[page.length - 1].createdAt.toISOString()
      : null;
    return { authors, nextCursor };
  }

  /**
   * Cursor-paginated list of posts that quote a given post (quotedPostId = postId).
   * Applies full viewer gating on the quoting posts themselves.
   */
  async listQuotes(params: {
    viewerUserId: string | null;
    postId: string;
    limit: number;
    cursor: string | null;
  }): Promise<{ posts: FeedPost[]; nextCursor: string | null }> {
    const { viewerUserId, postId, limit, cursor } = params;

    const post = await this.prisma.post.findFirst({
      where: { id: postId, deletedAt: null, isDraft: false },
      select: {
        id: true,
        visibility: true,
        userId: true,
        communityGroupId: true,
      },
    });
    if (!post) throw new NotFoundException("Post not found.");

    const viewer = await this.viewerContextService.getViewer(viewerUserId);
    const allowed = this.enrichment.allowedVisibilitiesForViewer(viewer);
    if (!allowed.includes(post.visibility))
      throw new NotFoundException("Post not found.");

    // Enforce group membership — non-members must not list quotes of a private group post.
    try {
      await this.access.assertReadableCommunityGroupPost(post, viewerUserId, viewer);
    } catch {
      throw new NotFoundException("Post not found.");
    }

    const quotes = await this.prisma.post.findMany({
      where: {
        quotedPostId: postId,
        deletedAt: null,
        isDraft: false,
        visibility: { in: allowed },
        kind: { not: "repost" },
        ...(cursor ? { createdAt: { lt: new Date(cursor) } } : {}),
      },
      orderBy: { createdAt: "desc" },
      take: limit + 1,
      include: {
        user: { select: USER_LIST_SELECT },
        media: { orderBy: { position: "asc" } },
        mentions: { include: { user: { select: MENTION_USER_SELECT } } },
      },
    });

    const hasMore = quotes.length > limit;
    const page = hasMore ? quotes.slice(0, limit) : quotes;
    const nextCursor = hasMore
      ? page[page.length - 1].createdAt.toISOString()
      : null;
    const visibleQuotes = await this.access.filterPostsByCommunityGroupAccess({
      viewerUserId,
      viewer,
      posts: page as unknown as FeedPost[],
    });
    return { posts: visibleQuotes, nextCursor };
  }
}
