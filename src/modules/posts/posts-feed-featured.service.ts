import { NOT_BANNED_USER_WHERE } from '../../common/prisma-selects/user.where';
import { ForbiddenException, Injectable } from "@nestjs/common";
import { Prisma } from "@prisma/client";
import type { PostVisibility } from "@prisma/client";
import { PrismaService } from "../prisma/prisma.service";
import { ViewerContextService } from "../viewer/viewer-context.service";
import { POSTS_RANKING } from "./posts-ranking.config";
import { mediaOnlyWhere, notDeletedWhere } from "./posts-query-builders";
import { feedPostInclude, type PopularFeedResult } from "./posts-feed.types";
import { PostsViewerEnrichmentService } from "./posts-viewer-enrichment.service";
import { PostsFeedAccessService } from "./posts-feed-access.service";
import { PostsFeedPopularService } from "./posts-feed-popular.service";
import { toPage } from '../../common/pagination/page';
import { createdAtIdBefore } from '../../common/pagination/created-at-id-cursor';
import { NOT_DELETED } from '../../common/prisma/where';

@Injectable()
export class PostsFeedFeaturedService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly viewerContextService: ViewerContextService,
    private readonly enrichment: PostsViewerEnrichmentService,
    private readonly access: PostsFeedAccessService,
    private readonly popular: PostsFeedPopularService,
  ) {}
  /** Featured/Explore feed: reads directly from Post.trendingScore, with per-author diversity and a "rising" blend. */
  private async listFeaturedFeedFromScore(params: {
    viewerUserId: string | null;
    limit: number;
    decodedCursor: { score: number; createdAt: string; id: string } | null;
    visibility: "all" | PostVisibility;
    allowed: PostVisibility[];
    authorUserIds: string[] | null;
    mediaOnly?: boolean;
    topLevelOnly?: boolean;
  }): Promise<PopularFeedResult> {
    const {
      viewerUserId,
      limit,
      decodedCursor,
      visibility,
      allowed,
      authorUserIds,
    } = params;
    const now = new Date();

    const baseVisibilityWhere: Prisma.PostWhereInput =
      visibility === "all"
        ? { visibility: { in: allowed } }
        : visibility === "public"
          ? { visibility: "public" }
          : { visibility };

    const visibilityWhere: Prisma.PostWhereInput =
      viewerUserId && visibility === "all"
        ? {
            OR: [
              baseVisibilityWhere,
              { userId: viewerUserId, visibility: { not: "onlyMe" } },
            ],
          }
        : baseVisibilityWhere;

    const lookbackMs = POSTS_RANKING.featuredLookbackDays * 24 * 60 * 60 * 1000;
    const featuredMinCreatedAt = new Date(now.getTime() - lookbackMs);

    const cursorScore = decodedCursor?.score ?? null;
    const cursorCreatedAt = decodedCursor
      ? new Date(decodedCursor.createdAt)
      : null;
    const cursorId = decodedCursor?.id ?? null;

    // Subsequent pages: trendingScore-ordered fetch with per-author diversity.
    if (decodedCursor && cursorScore != null && cursorCreatedAt && cursorId) {
      const scanTake = Math.min(
        POSTS_RANKING.featuredScanTakeMax,
        Math.max(limit * 40, limit + 1),
      );
      const rows = (await this.prisma.post.findMany({
        where: {
          ...NOT_DELETED,
          communityGroupId: null,
          boardOnly: false,
          trendingScore: { gt: 0 },
          parentId: null,
          createdAt: { gte: featuredMinCreatedAt },
          user: NOT_BANNED_USER_WHERE,
          ...(viewerUserId ? { userId: { not: viewerUserId } } : {}),
          ...(authorUserIds?.length ? { userId: { in: authorUserIds } } : {}),
          ...(params.mediaOnly ? mediaOnlyWhere() : {}),
          ...(params.topLevelOnly ? { parentId: null } : {}),
          ...visibilityWhere,
          OR: [
            { trendingScore: { lt: cursorScore } } as Prisma.PostWhereInput,
            {
              AND: [
                { trendingScore: cursorScore } as Prisma.PostWhereInput,
                createdAtIdBefore({ createdAt: cursorCreatedAt, id: cursorId }),
              ],
            },
          ],
        },
        orderBy: [
          { trendingScore: "desc" },
          { createdAt: "desc" },
          { id: "desc" },
        ],
        take: scanTake,
        select: {
          id: true,
          createdAt: true,
          trendingScore: true,
          userId: true,
        },
      })) as Array<{
        id: string;
        createdAt: Date;
        trendingScore: number;
        userId: string;
      }>;

      const picked: typeof rows = [];
      const perAuthor = new Map<string, number>();
      for (const r of rows) {
        if (picked.length >= limit + 1) break;
        const n = perAuthor.get(r.userId) ?? 0;
        if (n >= POSTS_RANKING.featuredMaxPerAuthor) continue;
        perAuthor.set(r.userId, n + 1);
        picked.push(r);
      }

      const { items: sliceRows, nextCursor } = toPage(picked, limit, (r) =>
        this.access.encodePopularCursor({ score: r.trendingScore, createdAt: r.createdAt.toISOString(), id: r.id }),
      );
      const ids = sliceRows.map((r) => r.id);

      const posts = ids.length
        ? await this.prisma.post.findMany({
            where: { id: { in: ids }, ...notDeletedWhere() },
            include: feedPostInclude,
          })
        : [];
      const byId = new Map(posts.map((p) => [p.id, p] as const));
      const ordered = ids
        .map((id) => byId.get(id))
        .filter((p): p is (typeof posts)[number] => Boolean(p));

      const scoreByPostId = new Map<string, number>(
        sliceRows.map((r) => [r.id, r.trendingScore]),
      );
      return { posts: ordered, nextCursor, scoreByPostId };
    }

    // First page: blend top-scored posts + "rising" fresh posts for variety.
    const topTake = Math.max(
      1,
      Math.min(
        limit,
        Math.round(limit * POSTS_RANKING.featuredRisingMixTopRatio),
      ),
    );
    const risingTake = Math.max(0, limit - topTake);
    const scanTake = Math.min(
      POSTS_RANKING.featuredScanTakeMax,
      Math.max(topTake * 10, topTake + 1),
    );

    const topRows = (await this.prisma.post.findMany({
      where: {
        ...NOT_DELETED,
        communityGroupId: null,
        boardOnly: false,
        trendingScore: { gt: 0 },
        parentId: null,
        createdAt: { gte: featuredMinCreatedAt },
        user: NOT_BANNED_USER_WHERE,
        ...(viewerUserId ? { userId: { not: viewerUserId } } : {}),
        ...(authorUserIds?.length ? { userId: { in: authorUserIds } } : {}),
        ...(params.mediaOnly ? mediaOnlyWhere() : {}),
        ...(params.topLevelOnly ? { parentId: null } : {}),
        ...visibilityWhere,
      },
      orderBy: [
        { trendingScore: "desc" },
        { createdAt: "desc" },
        { id: "desc" },
      ],
      take: scanTake,
      select: { id: true, createdAt: true, trendingScore: true, userId: true },
    })) as Array<{
      id: string;
      createdAt: Date;
      trendingScore: number;
      userId: string;
    }>;

    const perAuthor = new Map<string, number>();
    const topPicked: typeof topRows = [];
    for (const r of topRows) {
      if (topPicked.length >= topTake + 1) break;
      const n = perAuthor.get(r.userId) ?? 0;
      if (n >= POSTS_RANKING.featuredMaxPerAuthor) continue;
      perAuthor.set(r.userId, n + 1);
      topPicked.push(r);
    }

    const topSlice = topPicked.slice(0, topTake);
    const topBoundaryRow =
      topSlice.length > 0 ? topSlice[topSlice.length - 1] : null;
    const nextCursor =
      topPicked.length > topTake && topBoundaryRow
        ? this.access.encodePopularCursor({
            score: topBoundaryRow.trendingScore,
            createdAt: topBoundaryRow.createdAt.toISOString(),
            id: topBoundaryRow.id,
          })
        : null;

    const excludePostIds = topSlice.map((r) => r.id);
    const excludePostIdsSql =
      excludePostIds.length > 0
        ? Prisma.sql`AND p."id" NOT IN (${Prisma.join(excludePostIds.map((id) => Prisma.sql`${id}`))})`
        : Prisma.sql``;

    const excludeAuthorIds = Array.from(perAuthor.keys());
    const excludeAuthorIdsSql =
      excludeAuthorIds.length > 0
        ? Prisma.sql`AND p."userId" NOT IN (${Prisma.join(excludeAuthorIds.map((id) => Prisma.sql`${id}`))})`
        : Prisma.sql``;

    const excludeSelfSql = viewerUserId
      ? Prisma.sql`AND p."userId" <> ${viewerUserId}`
      : Prisma.sql``;
    const authorFilterSql = authorUserIds?.length
      ? Prisma.sql`AND p."userId" IN (${Prisma.join(authorUserIds.map((id) => Prisma.sql`${id}`))})`
      : Prisma.sql``;
    const mediaOnlySql = params.mediaOnly
      ? Prisma.sql`AND EXISTS (SELECT 1 FROM "PostMedia" pm WHERE pm."postId" = p."id" AND pm."deletedAt" IS NULL)`
      : Prisma.sql``;
    const featuredTopLevelOnlySql = params.topLevelOnly
      ? Prisma.sql`AND p."parentId" IS NULL`
      : Prisma.sql``;

    const risingWindowMs =
      POSTS_RANKING.featuredRisingWindowHours * 60 * 60 * 1000;
    const risingMinCreatedAt = new Date(now.getTime() - risingWindowMs);

    const risingVisibilitiesForQuery: PostVisibility[] =
      visibility === "all"
        ? allowed
        : visibility === "public"
          ? (["public"] as PostVisibility[])
          : ([visibility] as PostVisibility[]);
    const risingVisibilitiesForQuerySql = risingVisibilitiesForQuery.map(
      (v) => Prisma.sql`${v}::"PostVisibility"`,
    );
    const risingVisibilityFilterSql = Prisma.sql`AND p."visibility" IN (${Prisma.join(risingVisibilitiesForQuerySql)})`;

    const risingRows =
      risingTake > 0
        ? await this.prisma.$queryRaw<
            Array<{
              id: string;
              createdAt: Date;
              score: number;
              userId: string;
            }>
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
                        EXTRACT(EPOCH FROM (${now}::timestamptz - p."createdAt"))
                      ) / ${POSTS_RANKING.featuredRisingHalfLifeSeconds}
                    )
                  ) AS DOUBLE PRECISION
                ) as "commentScore"
              FROM "Post" p
              WHERE
                p."parentId" IS NOT NULL
                AND p."deletedAt" IS NULL
                AND p."createdAt" >= ${risingMinCreatedAt}
              GROUP BY p."parentId"
            ),
            candidates AS (
              SELECT p."id"
              FROM "Post" p
              WHERE
                p."deletedAt" IS NULL
                AND p."communityGroupId" IS NULL AND p."boardOnly" = false
                AND p."parentId" IS NULL
                AND p."createdAt" >= ${risingMinCreatedAt}
                ${risingVisibilityFilterSql}
                ${excludeSelfSql}
                ${authorFilterSql}
                ${mediaOnlySql}
                ${featuredTopLevelOnlySql}
                ${excludePostIdsSql}
                ${excludeAuthorIdsSql}
                AND (p."boostCount" > 0 OR p."bookmarkCount" > 0 OR p."commentCount" > 0)
              ORDER BY (p."boostCount" + p."bookmarkCount" + p."commentCount") DESC, p."createdAt" DESC, p."id" DESC
              LIMIT 2000
            ),
            latest_hashtag_snapshot AS (
              SELECT (
                SELECT s."asOf"
                FROM "HashtagTrendingScoreSnapshot" s
                ORDER BY s."asOf" DESC
                LIMIT 1
              ) as "asOf"
            ),
            hashtag_global AS (
              SELECT
                CAST(MAX(h."score") AS DOUBLE PRECISION) as "maxScore"
              FROM "HashtagTrendingScoreSnapshot" h
              JOIN latest_hashtag_snapshot lhs ON TRUE
              WHERE
                lhs."asOf" IS NOT NULL
                AND h."asOf" = lhs."asOf"
                AND h."visibility" IN (${Prisma.join(risingVisibilitiesForQuerySql)})
            ),
            post_hashtag_scores AS (
              SELECT
                p."id" as "postId",
                CAST(MAX(h."score") AS DOUBLE PRECISION) as "maxTagScore"
              FROM "Post" p
              JOIN candidates c ON c."id" = p."id"
              CROSS JOIN LATERAL UNNEST(p."hashtags") AS t
              JOIN latest_hashtag_snapshot lhs ON TRUE
              LEFT JOIN "HashtagTrendingScoreSnapshot" h ON
                lhs."asOf" IS NOT NULL
                AND h."asOf" = lhs."asOf"
                AND h."visibility" = p."visibility"
                AND h."tag" = LOWER(TRIM(t))
              WHERE LOWER(TRIM(t)) <> ''
              GROUP BY p."id"
            ),
            scored AS (
              SELECT
                p."id" as "id",
                p."createdAt" as "createdAt",
                p."userId" as "userId",
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
                        EXTRACT(EPOCH FROM (${now}::timestamptz - p."createdAt"))
                      ) / ${POSTS_RANKING.featuredRisingHalfLifeSeconds}
                    )
                  )
                  +
                  (
                    (COALESCE(cs."commentScore", 0)::DOUBLE PRECISION) * ${POSTS_RANKING.commentScoreWeight}
                  )
                  +
                  (
                    CASE
                      WHEN hs."maxTagScore" IS NULL OR hs."maxTagScore" <= 0 THEN 0
                      ELSE
                        ${POSTS_RANKING.popularTrendingHashtagBaseBonus}
                        +
                        COALESCE(
                          LEAST(
                            1.0,
                            hs."maxTagScore" / NULLIF(hg."maxScore", 0)
                          ),
                          0
                        ) * ${POSTS_RANKING.popularTrendingHashtagMaxScaledBonus}
                    END
                  )
                  +
                  (
                    CASE
                      WHEN u."pinnedPostId" = p."id" THEN
                        (CASE WHEN u."premium" THEN ${POSTS_RANKING.pinScorePremium} WHEN u."verifiedStatus" <> 'none' THEN ${POSTS_RANKING.pinScoreVerified} ELSE ${POSTS_RANKING.pinScoreBase} END)
                        * POWER(
                          0.5,
                          GREATEST(0, EXTRACT(EPOCH FROM (${now}::timestamptz - p."createdAt"))) / ${POSTS_RANKING.featuredRisingHalfLifeSeconds}
                        )
                      ELSE 0
                    END
                  )
                  * ${POSTS_RANKING.popularTopLevelScoreBoost}
                  * (
                    1 + LEAST(
                      ${POSTS_RANKING.popularEngagementRateCap},
                      ${POSTS_RANKING.popularEngagementRateWeight} * (
                        (
                          CASE WHEN p."boostScore" IS NULL OR p."boostScoreUpdatedAt" IS NULL THEN 0
                          ELSE p."boostScore" END
                        )
                        +
                        ((p."bookmarkCount"::DOUBLE PRECISION) * 0.5 * POWER(0.5, GREATEST(0, EXTRACT(EPOCH FROM (${now}::timestamptz - p."createdAt")) / ${POSTS_RANKING.featuredRisingHalfLifeSeconds})))
                        +
                        ((COALESCE(cs."commentScore", 0)::DOUBLE PRECISION) * ${POSTS_RANKING.commentScoreWeight})
                      ) / GREATEST((p."weightedViewCount" + ${POSTS_RANKING.popularEngagementRateK})::DOUBLE PRECISION, ${POSTS_RANKING.popularEngagementRateK}::DOUBLE PRECISION)
                    )
                  )
                  AS DOUBLE PRECISION
                ) as "score"
              FROM "Post" p
              JOIN candidates c ON c."id" = p."id"
              LEFT JOIN "User" u ON u."id" = p."userId"
              LEFT JOIN comment_scores cs ON cs."postId" = p."id"
              CROSS JOIN hashtag_global hg
              LEFT JOIN post_hashtag_scores hs ON hs."postId" = p."id"
            )
            SELECT "id", "createdAt", "score", "userId"
            FROM scored
            WHERE "score" > 0
            ORDER BY "score" DESC, "createdAt" DESC, "id" DESC
            LIMIT 200
          `)
        : [];

    const risingPicked: Array<{
      id: string;
      createdAt: Date;
      score: number;
      userId: string;
    }> = [];
    for (const r of risingRows) {
      if (risingPicked.length >= risingTake) break;
      const n = perAuthor.get(r.userId) ?? 0;
      if (n >= POSTS_RANKING.featuredMaxPerAuthor) continue;
      perAuthor.set(r.userId, n + 1);
      risingPicked.push({
        id: r.id,
        createdAt: r.createdAt,
        score: r.score,
        userId: r.userId,
      });
    }

    // Interleave so Explore doesn't show "2 old + 1 new" clumped.
    // topSlice entries have `trendingScore`; normalize to a unified `score` field.
    const combined: Array<{ id: string; score: number }> = [];
    const topQueue = topSlice.map((r) => ({
      id: r.id,
      score: r.trendingScore,
    }));
    const risingQueue = risingPicked.map((r) => ({ id: r.id, score: r.score }));
    while (
      combined.length < limit &&
      (topQueue.length > 0 || risingQueue.length > 0)
    ) {
      if (topQueue.length > 0) combined.push(topQueue.shift()!);
      if (combined.length >= limit) break;
      if (risingQueue.length > 0) combined.push(risingQueue.shift()!);
    }

    const ids = combined.map((r) => r.id);
    const posts = ids.length
      ? await this.prisma.post.findMany({
          where: { id: { in: ids }, ...notDeletedWhere() },
          include: feedPostInclude,
        })
      : [];
    const byId = new Map(posts.map((p) => [p.id, p] as const));
    const ordered = ids
      .map((id) => byId.get(id))
      .filter((p): p is (typeof posts)[number] => Boolean(p));

    const scoreByPostId = new Map<string, number>(
      combined.map((r) => [r.id, r.score]),
    );
    return { posts: ordered, nextCursor, scoreByPostId };
  }

  async listFeaturedFeed(params: {
    viewerUserId: string | null;
    limit: number;
    cursor: string | null;
    visibility: "all" | PostVisibility;
    followingOnly?: boolean;
    kind?: "regular" | "checkin" | null;
    checkinDayKey?: string | null;
    /** When true, include the viewer's own posts (overrides home-feed self-exclusion). */
    includeSelf?: boolean;
    mediaOnly?: boolean;
    topLevelOnly?: boolean;
    authorUserIds?: string[] | null;
    /** Filter to posts whose author has a matching US state code (e.g. "VA"). */
    authorLocationState?: string | null;
  }): Promise<PopularFeedResult> {
    const {
      viewerUserId,
      limit,
      cursor,
      visibility,
      followingOnly = false,
    } = params;
    const requestedAuthorUserIds =
      (params.authorUserIds ?? null)
        ?.map((s) => (s ?? "").trim())
        .filter(Boolean)
        .slice(0, 50) ?? null;
    const kind = (params.kind ?? null) as "regular" | "checkin" | null;
    const checkinDayKey = (params.checkinDayKey ?? null)?.trim() || null;

    const viewer = await this.viewerContextService.getViewer(viewerUserId);
    const allowed = this.enrichment.allowedVisibilitiesForViewer(viewer);

    if (visibility === "verifiedOnly") {
      if (!viewer || viewer.verifiedStatus === "none")
        throw new ForbiddenException("Verify to view verified-only posts.");
    }
    if (visibility === "premiumOnly") {
      if (!viewer || !this.viewerContextService.isPremium(viewer)) {
        throw new ForbiddenException(
          "Upgrade to premium to view premium-only posts.",
        );
      }
    }

    if (followingOnly && !viewerUserId) {
      return { posts: [], nextCursor: null, scoreByPostId: new Map() };
    }

    const followingAuthorIds: string[] | null =
      followingOnly && viewerUserId
        ? await this.access.getAuthorIdsForFollowingFilter(viewerUserId)
        : null;

    const authorUserIds: string[] | null = requestedAuthorUserIds?.length
      ? followingAuthorIds?.length
        ? followingAuthorIds.filter((id) => requestedAuthorUserIds.includes(id))
        : requestedAuthorUserIds
      : followingAuthorIds;

    if (requestedAuthorUserIds && requestedAuthorUserIds.length === 0) {
      return { posts: [], nextCursor: null, scoreByPostId: new Map() };
    }
    if (authorUserIds && authorUserIds.length === 0) {
      // Intersection produced empty set.
      return { posts: [], nextCursor: null, scoreByPostId: new Map() };
    }

    // Featured snapshots don't encode post kind or day key; fall back to trending for filtered feeds.
    if (kind || checkinDayKey) {
      return await this.popular.listPopularFeed({
        viewerUserId,
        limit,
        cursor,
        visibility,
        followingOnly,
        kind,
        checkinDayKey,
        includeSelf: params.includeSelf,
        mediaOnly: params.mediaOnly,
        topLevelOnly: params.topLevelOnly,
        authorUserIds,
      });
    }

    const decoded = this.access.decodePopularCursor(cursor);

    return await this.listFeaturedFeedFromScore({
      viewerUserId,
      limit,
      decodedCursor: decoded,
      visibility,
      allowed,
      authorUserIds,
      mediaOnly: params.mediaOnly,
      topLevelOnly: params.topLevelOnly,
    });
  }
}
