import { ForbiddenException, Injectable, NotFoundException } from "@nestjs/common";
import { Prisma } from "@prisma/client";
import type { PostVisibility } from "@prisma/client";
import { PrismaService } from "../prisma/prisma.service";
import { ViewerContextService } from "../viewer/viewer-context.service";
import { createdAtIdCursorWhere } from "../../common/pagination/created-at-id-cursor";
import { POSTS_RANKING } from "./posts-ranking.config";
import { excludeCommunityGroupPostsWhere, notDeletedWhere } from "./posts-query-builders";
import { feedPostInclude, type PostCounts } from "./posts-feed.types";
import { PostsViewerEnrichmentService } from "./posts-viewer-enrichment.service";
import { totalUserPostsWhere } from "../../common/content-counts";
import { PostsFeedAccessService } from "./posts-feed-access.service";
import { PostsRankingService } from "./posts-ranking.service";
import { toPage } from "../../common/pagination/page";

/** A member's profile timeline: posts, replies, and reposts filtered for the viewer's access and the profile's visibility. */
@Injectable()
export class PostsFeedProfileService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly viewerContextService: ViewerContextService,
    private readonly enrichment: PostsViewerEnrichmentService,
    private readonly access: PostsFeedAccessService,
    private readonly ranking: PostsRankingService,
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

      const { items: sliceRows, nextCursor } = toPage(rows, limit, (r) =>
        this.access.encodePopularCursor({
          score: r.score,
          createdAt: r.createdAt.toISOString(),
          id: r.id,
        }),
      );
      const ids = sliceRows.map((r) => r.id);

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

    const { items: slice, nextCursor } = toPage(posts, limit, (r) => r.id);

    return { posts: slice, nextCursor, counts };
  }
}
