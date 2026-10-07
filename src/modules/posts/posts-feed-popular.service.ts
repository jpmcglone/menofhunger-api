import {ForbiddenException, Injectable} from "@nestjs/common";
import {Prisma} from "@prisma/client";
import type {PostVisibility} from "@prisma/client";
import {PrismaService} from "../prisma/prisma.service";
import {ViewerContextService} from "../viewer/viewer-context.service";
import {POSTS_RANKING} from "./posts-ranking.config";
import {excludeCommunityGroupPostsWhere, mediaOnlyWhere, notDeletedWhere, userNotBannedWhere} from "./posts-query-builders";
import {feedPostInclude, mediaFeedPostInclude, type FeedPost, type PopularFeedResult} from "./posts-feed.types";
import {PostsViewerEnrichmentService} from "./posts-viewer-enrichment.service";
import {PostsFeedAccessService} from "./posts-feed-access.service";
import {PostsRankingService} from "./posts-ranking.service";

@Injectable()
export class PostsFeedPopularService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly viewerContextService: ViewerContextService,
    private readonly enrichment: PostsViewerEnrichmentService,
    private readonly access: PostsFeedAccessService,
    private readonly ranking: PostsRankingService,
  ) {}
  /** Trending feed: reads directly from Post.trendingScore (set by the popular-score cron). */
  private async listPopularFeedFromScore(params: {
    viewerUserId: string | null;
    limit: number;
    decodedCursor: { score: number; createdAt: string; id: string } | null;
    visibility: "all" | PostVisibility;
    allowed: PostVisibility[];
    authorUserIds: string[] | null;
    kind: "regular" | "checkin" | null;
    mediaOnly?: boolean;
    topLevelOnly?: boolean;
    memberGroupIds?: string[];
    excludeAuthorUserId?: string | null;
    /** Filter to posts whose author has a matching US state code (e.g. "VA"). */
    authorLocationState?: string | null;
  }): Promise<PopularFeedResult> {
    const {
      viewerUserId,
      limit,
      decodedCursor,
      visibility,
      allowed,
      authorUserIds,
      kind,
    } = params;
    const memberGroupIds = params.memberGroupIds ?? [];

    const baseVisibilityWhere: Prisma.PostWhereInput =
      visibility === "all"
        ? { visibility: { in: allowed } }
        : visibility === "public"
          ? { visibility: "public" }
          : { visibility };

    // IMPORTANT: Only apply "author sees own posts" override when visibility='all'.
    const visibilityWhere: Prisma.PostWhereInput =
      viewerUserId && visibility === "all"
        ? {
            OR: [
              baseVisibilityWhere,
              { userId: viewerUserId, visibility: { not: "onlyMe" } },
            ],
          }
        : baseVisibilityWhere;

    const cursorScore = decodedCursor?.score ?? null;
    const cursorCreatedAt = decodedCursor
      ? new Date(decodedCursor.createdAt)
      : null;
    const cursorId = decodedCursor?.id ?? null;

    const communityScopeWhere: Prisma.PostWhereInput =
      memberGroupIds.length > 0
        ? {
            OR: [
              excludeCommunityGroupPostsWhere(),
              { communityGroupId: { in: memberGroupIds } },
            ],
          }
        : excludeCommunityGroupPostsWhere();

    const locationStateFilter: Prisma.PostWhereInput[] =
      params.authorLocationState
        ? ([
            { user: { locationState: params.authorLocationState } },
          ] as Prisma.PostWhereInput[])
        : [];

    const baseAnd: Prisma.PostWhereInput[] = [
      { deletedAt: null },
      { user: { bannedAt: null } },
      communityScopeWhere,
      ...(kind ? ([{ kind }] as Prisma.PostWhereInput[]) : []),
      ...(authorUserIds?.length
        ? ([{ userId: { in: authorUserIds } }] as Prisma.PostWhereInput[])
        : []),
      ...(params.excludeAuthorUserId
        ? ([
            { NOT: { userId: params.excludeAuthorUserId } },
          ] as Prisma.PostWhereInput[])
        : []),
      ...(params.mediaOnly ? [mediaOnlyWhere()] : []),
      ...(params.topLevelOnly
        ? ([{ parentId: null }] as Prisma.PostWhereInput[])
        : []),
      ...locationStateFilter,
      visibilityWhere,
    ];
    const include = params.mediaOnly ? mediaFeedPostInclude : feedPostInclude;
    const chronologicalScoreWhere: Prisma.PostWhereInput = {
      OR: [{ trendingScore: 0 }, { trendingScore: null }],
    };
    const chronologicalCursorWhere: Prisma.PostWhereInput =
      cursorCreatedAt && cursorId
        ? {
            OR: [
              { createdAt: { lt: cursorCreatedAt } },
              {
                AND: [{ createdAt: cursorCreatedAt }, { id: { lt: cursorId } }],
              },
            ],
          }
        : {};

    const toResult = (
      posts: FeedPost[],
      hasMore: boolean,
    ): PopularFeedResult => {
      const nextPost = hasMore ? (posts[posts.length - 1] ?? null) : null;
      const nextCursor = nextPost
        ? this.access.encodePopularCursor({
            score: nextPost.trendingScore ?? 0,
            createdAt: nextPost.createdAt.toISOString(),
            id: nextPost.id,
          })
        : null;
      const scoreByPostId = new Map<string, number>(
        posts.map((post) => [post.id, post.trendingScore ?? 0]),
      );
      return { posts, nextCursor, scoreByPostId };
    };

    if (decodedCursor && (cursorScore == null || cursorScore <= 0)) {
      const fallbackPosts = (await this.prisma.post.findMany({
        where: {
          AND: [...baseAnd, chronologicalScoreWhere, chronologicalCursorWhere],
        },
        orderBy: [{ createdAt: "desc" }, { id: "desc" }],
        take: limit + 1,
        include,
      })) as FeedPost[];
      return toResult(
        fallbackPosts.slice(0, limit),
        fallbackPosts.length > limit,
      );
    }

    const trendingCursorWhere: Prisma.PostWhereInput =
      decodedCursor && cursorScore != null && cursorCreatedAt && cursorId
        ? {
            OR: [
              { trendingScore: { lt: cursorScore } },
              {
                AND: [
                  { trendingScore: cursorScore },
                  {
                    OR: [
                      { createdAt: { lt: cursorCreatedAt } },
                      {
                        AND: [
                          { createdAt: cursorCreatedAt },
                          { id: { lt: cursorId } },
                        ],
                      },
                    ],
                  },
                ],
              },
            ],
          }
        : {};

    const trendingPosts = (await this.prisma.post.findMany({
      where: {
        AND: [...baseAnd, { trendingScore: { gt: 0 } }, trendingCursorWhere],
      },
      orderBy: [
        { trendingScore: "desc" },
        { createdAt: "desc" },
        { id: "desc" },
      ],
      take: limit + 1,
      include,
    })) as FeedPost[];

    if (trendingPosts.length > limit) {
      return toResult(trendingPosts.slice(0, limit), true);
    }

    const remaining = limit - trendingPosts.length;
    const fallbackPosts = (await this.prisma.post.findMany({
      where: {
        AND: [...baseAnd, chronologicalScoreWhere],
      },
      orderBy: [{ createdAt: "desc" }, { id: "desc" }],
      take: Math.max(1, remaining + 1),
      include,
    })) as FeedPost[];
    const fallbackSlice =
      remaining > 0 ? fallbackPosts.slice(0, remaining) : [];
    const hasMoreFallback = fallbackPosts.length > remaining;
    return toResult([...trendingPosts, ...fallbackSlice], hasMoreFallback);
  }

  async listPopularFeed(params: {
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

    // Group posts are excluded from all home feeds. Pass an empty array so
    // listPopularFeedFromScore always resolves communityScopeWhere to excludeCommunityGroupPostsWhere().
    const memberGroupIds: string[] = [];

    const visibilityWhere =
      visibility === "all"
        ? ({ visibility: { in: allowed } } as Prisma.PostWhereInput)
        : visibility === "public"
          ? ({ visibility: "public" } as Prisma.PostWhereInput)
          : ({ visibility } as Prisma.PostWhereInput);

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

    // Exclude the viewer's own posts from home feeds (Following + All) unless the feed
    // is explicitly scoped to a set of author IDs (e.g. profile view, crew feed),
    // or the caller explicitly opts in with includeSelf (e.g. per-day check-in feeds).
    // Use requestedAuthorUserIds (not authorUserIds) as the gate so the trending Following
    // path (where authorUserIds already excludes the viewer via getAuthorIdsForFollowingFilter)
    // doesn't double-apply the exclusion.
    const excludeViewerAuthor =
      Boolean(viewerUserId) &&
      !requestedAuthorUserIds?.length &&
      !params.includeSelf;

    // Fast path: use the stored trendingScore column (set by the popular-score cron every ~10 min).
    // For kind-filtered views (e.g. check-ins) or day-scoped views, fall back to real-time scoring
    // so brand-new posts that haven't been scored yet can still surface immediately.
    if (!kind && !checkinDayKey) {
      return await this.listPopularFeedFromScore({
        viewerUserId,
        limit,
        decodedCursor: decoded,
        visibility,
        allowed,
        authorUserIds,
        kind,
        mediaOnly: params.mediaOnly,
        topLevelOnly: params.topLevelOnly,
        memberGroupIds,
        excludeAuthorUserId: excludeViewerAuthor ? viewerUserId : null,
        authorLocationState: params.authorLocationState ?? null,
      });
    }

    // Stable pagination: use now as the scoring reference time.
    // Minor inconsistency across pages is acceptable for kind-filtered views (real-time feed).
    const asOf = new Date();
    const asOfMs = asOf.getTime();
    const lookbackMs = POSTS_RANKING.popularLookbackDays * 24 * 60 * 60 * 1000;
    // When scoped to a specific check-in day the day key is the natural date bound —
    // skip the rolling lookback window so historical day feeds are never empty.
    const minCreatedAt = checkinDayKey
      ? new Date(0)
      : new Date(asOfMs - lookbackMs);

    const warmupAuthorFilter = authorUserIds?.length
      ? ({ userId: { in: authorUserIds } } as Prisma.PostWhereInput)
      : undefined;
    const warmupKindFilter = kind
      ? ({ kind } as Prisma.PostWhereInput)
      : undefined;
    const warmupCheckinDayKeyFilter = checkinDayKey
      ? ({ checkinDayKey } as Prisma.PostWhereInput)
      : undefined;
    const warmupTopLevelFilter = params.topLevelOnly
      ? ({ parentId: null } as Prisma.PostWhereInput)
      : undefined;

    // IMPORTANT: Only apply "author sees own posts" override when visibility='all'.
    // When user explicitly filters by a specific visibility, respect that filter even for their own posts.
    const popularVisibilityWhere =
      viewerUserId && visibility === "all"
        ? ({
            OR: [
              visibilityWhere,
              // Author sees own posts (e.g. after tier downgrade), but never include only-me outside /only-me.
              { userId: viewerUserId, visibility: { not: "onlyMe" } },
            ],
          } as Prisma.PostWhereInput)
        : visibilityWhere;

    if (!decoded) {
      const staleBefore = new Date(asOfMs - POSTS_RANKING.boostScoreTtlMs);
      const warmup = await this.prisma.post.findMany({
        where: {
          AND: [
            popularVisibilityWhere,
            { parentId: null },
            excludeCommunityGroupPostsWhere(),
            ...(warmupAuthorFilter ? [warmupAuthorFilter] : []),
            ...(excludeViewerAuthor && viewerUserId
              ? ([{ NOT: { userId: viewerUserId } }] as Prisma.PostWhereInput[])
              : []),
            ...(warmupKindFilter ? [warmupKindFilter] : []),
            ...(warmupCheckinDayKeyFilter ? [warmupCheckinDayKeyFilter] : []),
            ...(warmupTopLevelFilter ? [warmupTopLevelFilter] : []),
            notDeletedWhere(),
            userNotBannedWhere(),
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

    // Snapshot `asOf` *after* any warmup updates, so we never "amplify" scores.
    const snapshotAsOf = decoded ? asOf : new Date();
    // For day-scoped feeds the lookback is irrelevant — use epoch so no posts are dropped.
    const snapshotMinCreatedAt = checkinDayKey
      ? new Date(0)
      : new Date(snapshotAsOf.getTime() - lookbackMs);
    // recentCutoff is only meaningful for the "recency bucket" on global feeds.
    // For day-scoped feeds set it to epoch so the recency bucket captures everything.
    const recentCutoff = checkinDayKey
      ? new Date(0)
      : new Date(
          snapshotAsOf.getTime() -
            POSTS_RANKING.popularRecentWindowHours * 60 * 60 * 1000,
        );

    const cursorCreatedAt = decoded ? new Date(decoded.createdAt) : null;
    const cursorScore = decoded?.score ?? null;
    const cursorId = decoded?.id ?? null;

    const authorFilterSql = authorUserIds?.length
      ? Prisma.sql`AND p."userId" IN (${Prisma.join(authorUserIds.map((id) => Prisma.sql`${id}`))})`
      : Prisma.sql``;
    const excludeSelfSql =
      excludeViewerAuthor && viewerUserId
        ? Prisma.sql`AND p."userId" <> ${viewerUserId}`
        : Prisma.sql``;
    // NOTE: Postgres enum compare requires matching enum type. Cast to text to safely compare against our string param.
    const kindFilterSql = kind
      ? Prisma.sql`AND (p."kind"::text = ${kind})`
      : Prisma.sql``;
    const checkinDayKeyFilterSql = checkinDayKey
      ? Prisma.sql`AND p."checkinDayKey" = ${checkinDayKey}`
      : Prisma.sql``;
    const topLevelOnlySql = params.topLevelOnly
      ? Prisma.sql`AND p."parentId" IS NULL`
      : Prisma.sql``;

    // IMPORTANT: Only apply "author sees own posts" override when visibility='all'.
    // When user explicitly filters by a specific visibility, respect that filter even for their own posts.
    const visibilityFilterSql =
      viewerUserId && visibility === "all"
        ? Prisma.sql`AND (p."visibility" IN (${Prisma.join(visibilitiesForQuerySql)}) OR (p."userId" = ${viewerUserId} AND p."visibility" <> 'onlyMe'))`
        : Prisma.sql`AND p."visibility" IN (${Prisma.join(visibilitiesForQuerySql)})`;

    const bannedAuthorSql = Prisma.sql`AND (SELECT u."bannedAt" FROM "User" u WHERE u."id" = p."userId") IS NULL`;

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
      candidates AS (
        SELECT u."id" as "id"
        FROM (
          (
            -- Recency bucket: include recent posts even with no engagement.
            SELECT p."id"
            FROM "Post" p
            WHERE
              p."deletedAt" IS NULL
              AND p."parentId" IS NULL
              AND p."createdAt" >= ${snapshotMinCreatedAt}
              AND p."createdAt" >= ${recentCutoff}
              ${visibilityFilterSql}
              ${authorFilterSql}
              ${excludeSelfSql}
              ${kindFilterSql}
              ${checkinDayKeyFilterSql}
              ${topLevelOnlySql}
              ${bannedAuthorSql}
            ORDER BY p."createdAt" DESC, p."id" DESC
            LIMIT ${POSTS_RANKING.popularCandidatesRecentTake}
          )
          UNION
          (
            -- Engagement buckets: top boosted, bookmarked, and commented.
            SELECT p."id"
            FROM "Post" p
            WHERE
              p."deletedAt" IS NULL
              AND p."parentId" IS NULL
              AND p."createdAt" >= ${snapshotMinCreatedAt}
              AND p."boostCount" > 0
              ${visibilityFilterSql}
              ${authorFilterSql}
              ${excludeSelfSql}
              ${kindFilterSql}
              ${checkinDayKeyFilterSql}
              ${topLevelOnlySql}
              ${bannedAuthorSql}
            ORDER BY p."boostCount" DESC, p."createdAt" DESC, p."id" DESC
            LIMIT ${POSTS_RANKING.popularCandidatesBoostedTake}
          )
          UNION
          (
            SELECT p."id"
            FROM "Post" p
            WHERE
              p."deletedAt" IS NULL
              AND p."parentId" IS NULL
              AND p."createdAt" >= ${snapshotMinCreatedAt}
              AND p."bookmarkCount" > 0
              ${visibilityFilterSql}
              ${authorFilterSql}
              ${excludeSelfSql}
              ${kindFilterSql}
              ${checkinDayKeyFilterSql}
              ${topLevelOnlySql}
              ${bannedAuthorSql}
            ORDER BY p."bookmarkCount" DESC, p."createdAt" DESC, p."id" DESC
            LIMIT ${POSTS_RANKING.popularCandidatesBookmarkedTake}
          )
          UNION
          (
            SELECT p."id"
            FROM "Post" p
            WHERE
              p."deletedAt" IS NULL
              AND p."parentId" IS NULL
              AND p."createdAt" >= ${snapshotMinCreatedAt}
              AND p."commentCount" > 0
              ${visibilityFilterSql}
              ${authorFilterSql}
              ${excludeSelfSql}
              ${kindFilterSql}
              ${checkinDayKeyFilterSql}
              ${topLevelOnlySql}
              ${bannedAuthorSql}
            ORDER BY p."commentCount" DESC, p."createdAt" DESC, p."id" DESC
            LIMIT ${POSTS_RANKING.popularCandidatesCommentedTake}
          )
          UNION
          (
            -- Posts that have been reposted are signals of content spread/virality.
            SELECT p."id"
            FROM "Post" p
            WHERE
              p."deletedAt" IS NULL
              AND p."parentId" IS NULL
              AND p."createdAt" >= ${snapshotMinCreatedAt}
              AND p."repostCount" > 0
              ${visibilityFilterSql}
              ${authorFilterSql}
              ${excludeSelfSql}
              ${kindFilterSql}
              ${checkinDayKeyFilterSql}
              ${topLevelOnlySql}
              ${bannedAuthorSql}
            ORDER BY p."repostCount" DESC, p."createdAt" DESC, p."id" DESC
            LIMIT ${POSTS_RANKING.popularCandidatesRepostedTake}
          )
          UNION
          (
            -- Replies with engagement can become popular; top-level posts get a slight boost in scoring.
            SELECT p."id"
            FROM "Post" p
            WHERE
              p."deletedAt" IS NULL
              AND p."parentId" IS NOT NULL
              AND p."createdAt" >= ${snapshotMinCreatedAt}
              AND (p."boostCount" > 0 OR p."bookmarkCount" > 0)
              ${visibilityFilterSql}
              ${authorFilterSql}
              ${excludeSelfSql}
              ${kindFilterSql}
              ${checkinDayKeyFilterSql}
              ${topLevelOnlySql}
              ${bannedAuthorSql}
            ORDER BY (p."boostCount" + p."bookmarkCount") DESC, p."createdAt" DESC, p."id" DESC
            LIMIT ${POSTS_RANKING.popularCandidatesRepliesTake}
          )
        ) u
        JOIN "Post" _cg ON _cg."id" = u."id" AND _cg."communityGroupId" IS NULL AND _cg."boardOnly" = false
        GROUP BY u."id"
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
          AND h."visibility" IN (${Prisma.join(visibilitiesForQuerySql)})
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
              -- Bookmarks are a quieter signal than boosts: they indicate “save for later,”
              -- so we count them, but decay them by post age so this stays “trending”.
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
                    GREATEST(0, EXTRACT(EPOCH FROM (${snapshotAsOf}::timestamptz - p."createdAt"))) / ${POSTS_RANKING.popularHalfLifeSeconds}
                  )
                ELSE 0
              END
            )
            * (CASE WHEN p."parentId" IS NULL THEN ${POSTS_RANKING.popularTopLevelScoreBoost} ELSE 1.0 END)
            * POWER(
              ${POSTS_RANKING.deletedAncestorPenalty},
              (
                (CASE WHEN parent."deletedAt" IS NOT NULL THEN 1 ELSE 0 END)
                +
                (CASE
                  WHEN root."deletedAt" IS NOT NULL AND (parent."id" IS NULL OR root."id" <> parent."id") THEN 1
                  ELSE 0
                END)
              )
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
        JOIN candidates c ON c."id" = p."id"
        LEFT JOIN "User" u ON u."id" = p."userId"
        LEFT JOIN "Post" parent ON parent."id" = p."parentId"
        LEFT JOIN "Post" root ON root."id" = COALESCE(p."rootId", p."id")
        LEFT JOIN comment_scores cs ON cs."postId" = p."id"
        CROSS JOIN hashtag_global hg
        LEFT JOIN post_hashtag_scores hs ON hs."postId" = p."id"
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
          where: { id: { in: ids }, ...notDeletedWhere() },
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
    return { posts: ordered, nextCursor, scoreByPostId };
  }
}
