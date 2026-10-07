import {selectFreshForYou} from './for-you-freshness';
import {ConversationsService} from "./conversations.service";
import {ForbiddenException, Injectable} from "@nestjs/common";
import {Prisma, type PostVisibility} from "@prisma/client";
import {PrismaService} from "../prisma/prisma.service";
import {ViewerContextService} from "../viewer/viewer-context.service";
import {friendEngagementSql} from "./posts-friend-engagement.sql";
import {POSTS_RANKING} from "./posts-ranking.config";
import {generateRandomSeed, seededUnitInterval} from "../../common/random/seeded-random";
import {excludeCommunityGroupPostsWhere, mediaOnlyWhere, notDeletedWhere} from "./posts-query-builders";
import {
  feedPostInclude,
  mediaFeedPostInclude,
  type FeedPost,
  type PopularFeedResult,
} from "./posts-feed.types";
import {PostsViewerEnrichmentService} from "./posts-viewer-enrichment.service";
import {CacheService} from "../redis/cache.service";
import {CacheInvalidationService} from "../redis/cache-invalidation.service";
import {CacheTtl} from "../redis/cache-ttl";
import {RedisKeys, stableJsonHash} from "../redis/redis-keys";
import {PostsFeedAccessService} from "./posts-feed-access.service";
import {
  addForYouRows,
  loadForYouNetworkCandidates,
  type ForYouScannedRow,
} from "./posts-feed-for-you-lanes";

type ForYouRankedShell = {
  ids: string[];
  nextCursor: string | null;
  scores: Array<[string, number]>;
};

type ForYouFeedParams = {
  viewerUserId: string | null;
  limit: number;
  cursor: string | null;
  visibility: "all" | PostVisibility;
  kind?: "regular" | "checkin" | null;
  checkinDayKey?: string | null;
  includeSelf?: boolean;
  mediaOnly?: boolean;
  topLevelOnly?: boolean;
  authorUserIds?: string[] | null;
  authorLocationState?: string | null;
  refresh?: boolean;
};

@Injectable()
export class PostsFeedForYouService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly viewerContextService: ViewerContextService,
    private readonly enrichment: PostsViewerEnrichmentService,
    private readonly cache: CacheService,
    private readonly cacheInvalidation: CacheInvalidationService,
    private readonly access: PostsFeedAccessService,
    private readonly conversations: ConversationsService = undefined!,
  ) {}
  async listForYouFeed(params: ForYouFeedParams): Promise<PopularFeedResult> {
    const viewerUserId = params.viewerUserId?.trim() || null;
    const hasCursor = Boolean(params.cursor?.trim());
    if (!viewerUserId || hasCursor || params.refresh) {
      return this.listForYouFeedUncached(params);
    }

    const feedVer = await this.cacheInvalidation.feedGlobalVersion();
    const forYouUserVer =
      await this.cacheInvalidation.forYouUserVersion(viewerUserId);
    const paramsHash = stableJsonHash({
      endpoint: "posts:forYou:ranked-page1",
      limit: params.limit,
      visibility: params.visibility,
      kind: params.kind ?? null,
      checkinDayKey: params.checkinDayKey?.trim() || null,
      includeSelf: params.includeSelf ?? false,
      mediaOnly: params.mediaOnly ?? false,
      topLevelOnly: params.topLevelOnly ?? false,
      authorUserIds: (params.authorUserIds ?? [])
        .map((id) => id.trim())
        .filter(Boolean)
        .sort(),
      authorLocationState:
        params.authorLocationState?.trim().toUpperCase() || null,
      forYouUserVer,
    });
    const key = RedisKeys.forYouRankedPage1(viewerUserId, paramsHash, feedVer);
    const lockKey = RedisKeys.forYouRankedPage1Lock(
      viewerUserId,
      paramsHash,
      feedVer,
    );
    let computed: PopularFeedResult | null = null;

    const computeShell = async (): Promise<ForYouRankedShell> => {
      computed = await this.listForYouFeedUncached(params);
      return {
        ids: computed.posts.map((post) => post.id),
        nextCursor: computed.nextCursor,
        scores: [...computed.scoreByPostId.entries()],
      };
    };

    const shell = await this.cache.getOrSetJsonWithLock<ForYouRankedShell>({
      enabled: true,
      key,
      ttlSeconds: CacheTtl.forYouRankedPage1Seconds,
      lockKey,
      lockTtlMs: 10_000,
      lockWaitMs: 750,
      computeAndSet: computeShell,
      fallback: computeShell,
      waitForResult: true,
    });
    if (computed) return computed;

    const rows = shell.ids.length
      ? ((await this.prisma.post.findMany({
          where: { id: { in: shell.ids }, ...notDeletedWhere() },
          include: params.mediaOnly ? mediaFeedPostInclude : feedPostInclude,
        })) as FeedPost[])
      : [];
    const byId = new Map(rows.map((post) => [post.id, post] as const));
    const ordered = shell.ids
      .map((id) => byId.get(id))
      .filter((post): post is FeedPost => Boolean(post));
    return {
      posts: ordered,
      nextCursor: shell.nextCursor,
      scoreByPostId: new Map(shell.scores),
    };
  }

  private async listForYouFeedUncached(
    params: ForYouFeedParams,
  ): Promise<PopularFeedResult> {
    const { viewerUserId, cursor, visibility } = params;
    let limit = params.limit;
    const kind = (params.kind ?? null) as "regular" | "checkin" | null;
    const checkinDayKey = (params.checkinDayKey ?? null)?.trim() || null;
    const requestedAuthorUserIds =
      (params.authorUserIds ?? null)
        ?.map((s) => (s ?? "").trim())
        .filter(Boolean)
        .slice(0, 50) ?? null;
    if (requestedAuthorUserIds && requestedAuthorUserIds.length === 0) {
      return { posts: [], nextCursor: null, scoreByPostId: new Map() };
    }

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

    const baseVisibilityWhere: Prisma.PostWhereInput =
      visibility === "all"
        ? { visibility: { in: allowed } }
        : visibility === "public"
          ? { visibility: "public" }
          : { visibility };

    const blockSets = viewerUserId
      ? await this.enrichment.viewerBlockSets(viewerUserId)
      : {
          blockedByViewer: new Set<string>(),
          viewerBlockedBy: new Set<string>(),
        };
    const mutedIds = requestedAuthorUserIds?.length
      ? []
      : await this.access.viewerMutedIds(viewerUserId);
    const blockedAuthorIds = [
      ...new Set([
        ...blockSets.blockedByViewer,
        ...blockSets.viewerBlockedBy,
        ...mutedIds,
      ]),
    ];
    const blockedAuthorSet = new Set(blockedAuthorIds);

    // Author filter: intersect requested authors (if any) with "not the viewer". We don't filter
    // `parentId IS NULL` so engaged replies stay first-class trending candidates — the controller's
    // `collapseFeedByRoot` rolls them up to their root for display.
    // When includeSelf is true (e.g. per-day check-in feeds), the viewer's own posts are kept.
    const userIdWhere: Prisma.PostWhereInput["userId"] =
      requestedAuthorUserIds?.length
        ? {
            in: requestedAuthorUserIds.filter(
              (id) => id !== viewerUserId && !blockedAuthorSet.has(id),
            ),
          }
        : blockedAuthorIds.length > 0
          ? params.includeSelf
            ? { notIn: blockedAuthorIds }
            : {
                notIn: viewerUserId
                  ? [viewerUserId, ...blockedAuthorIds]
                  : blockedAuthorIds,
              }
          : viewerUserId && !params.includeSelf
            ? { not: viewerUserId }
            : undefined;

    if (
      requestedAuthorUserIds?.length &&
      (userIdWhere as { in: string[] }).in.length === 0
    ) {
      return { posts: [], nextCursor: null, scoreByPostId: new Map() };
    }

    const commonWhere: Prisma.PostWhereInput = {
      deletedAt: null,
      ...(kind ? { kind } : {}),
      user: { bannedAt: null },
      ...(userIdWhere !== undefined ? { userId: userIdWhere } : {}),
      ...(checkinDayKey ? { checkinDayKey } : {}),
      ...(params.mediaOnly ? mediaOnlyWhere() : {}),
      ...(params.topLevelOnly ? { parentId: null } : {}),
      ...baseVisibilityWhere,
    };
    const baseWhere: Prisma.PostWhereInput = {
      ...commonWhere,
      ...excludeCommunityGroupPostsWhere(),
    };

    const decodedForYouCursor = await this.access.decodeForYouCursor(
      cursor,
      viewerUserId,
    );
    const servedIds = decodedForYouCursor.servedIds;
    limit = Math.min(
      limit,
      POSTS_RANKING.forYouSessionMaxPosts - servedIds.length,
    );
    if (limit <= 0)
      return { posts: [], nextCursor: null, scoreByPostId: new Map() };
    const isPage1 = servedIds.length === 0;
    const servedWhere: Prisma.PostWhereInput[] =
      servedIds.length > 0 ? [{ id: { notIn: servedIds } }] : [];
    // Page 1 (refresh, cursor === null) always mints a fresh seed so the jitter below
    // reshuffles the feed. Deeper pages reuse the seed carried in the cursor so the
    // per-post jitter stays stable while paginating (no reordering mid-scroll).
    const jitterSeed = decodedForYouCursor.seed ?? generateRandomSeed();

    const fetchChronologicalMediaFallback = async (
      take: number,
      excludeIds: string[],
    ): Promise<{ posts: FeedPost[]; overflow: boolean }> => {
      if (!params.mediaOnly || take <= 0) return { posts: [], overflow: false };
      const rows = (await this.prisma.post.findMany({
        where: {
          AND: [
            baseWhere,
            ...servedWhere,
            ...(excludeIds.length > 0
              ? ([{ id: { notIn: excludeIds } }] as Prisma.PostWhereInput[])
              : []),
          ],
        },
        orderBy: [{ createdAt: "desc" }, { id: "desc" }],
        take: take + 1,
        include: mediaFeedPostInclude,
      })) as FeedPost[];
      return { posts: rows.slice(0, take), overflow: rows.length > take };
    };

    // Keep legacy popular cursor support for users who loaded page one before this deploy.
    const legacyCursor = decodedForYouCursor.legacyPopular;
    const cursorRow = legacyCursor
      ? await this.prisma.post.findFirst({
          where: { id: legacyCursor.id, deletedAt: null },
          select: { id: true, createdAt: true, trendingScore: true },
        })
      : null;
    const inTrendingHead = Boolean(
      cursorRow &&
      cursorRow.trendingScore != null &&
      cursorRow.trendingScore > 0,
    );
    const fallbackOnly = Boolean(legacyCursor) && !inTrendingHead;

    // A pull-to-refresh pays for the wider scan so refreshing can actually reach posts the
    // narrow first-paint pool never contained. First paint keeps the tighter budget.
    const isRefreshPage = Boolean(params.refresh) && isPage1;
    const scanTake =
      isPage1 && !isRefreshPage
        ? Math.min(
            POSTS_RANKING.forYouPage1ScanTakeMax,
            Math.max(limit + 10, limit * 2),
          )
        : Math.min(
            POSTS_RANKING.forYouScanTakeMax,
            Math.max(limit + 10, limit * 4),
          );

    let trendingScanned: ForYouScannedRow[] = [];
    let chronoScanned: ForYouScannedRow[] = [];
    let discoveryOverflow = false;

    const viewerFollowingRows = viewerUserId
      ? await this.access.rankingInput(viewerUserId, "following", () =>
          this.prisma.follow.findMany({
            where: { followerId: viewerUserId },
            select: { followingId: true },
          }),
        )
      : [];
    const viewerFollowingIds = [
      ...new Set(viewerFollowingRows.map((r) => r.followingId).filter(Boolean)),
    ];
    const followingCandidateIds = requestedAuthorUserIds
      ? viewerFollowingIds.filter(
          (id) => requestedAuthorUserIds.includes(id) && id !== viewerUserId,
        )
      : viewerFollowingIds.filter((id) => id !== viewerUserId);

    const followedSince = new Date(
      Date.now() -
        POSTS_RANKING.forYouRecentFollowedWindowHours * 60 * 60 * 1000,
    );
    const secondDegreeSince = new Date(
      Date.now() - POSTS_RANKING.forYouSecondDegreeWindowHours * 60 * 60 * 1000,
    );
    const groupSince = new Date(
      Date.now() - POSTS_RANKING.forYouGroupWindowHours * 60 * 60 * 1000,
    );
    const engagedWithSince = new Date(
      Date.now() -
        POSTS_RANKING.forYouEngagedWithWindowDays * 24 * 60 * 60 * 1000,
    );
    const directNetworkExcludedIds = [
      ...new Set([
        ...(viewerUserId ? [viewerUserId] : []),
        ...viewerFollowingIds,
        ...blockedAuthorIds,
      ]),
    ];
    // Group posts are excluded from home feeds. These lanes are intentionally dormant:
    // memberGroupIds and viewerCanReadOpenGroups are forced to empty/false so the
    // member-group and open-follow-group candidate queries (below) always resolve to [].
    const memberGroupIds: string[] = [];
    const viewerCanReadOpenGroups = false;
    const secondDegreePathCountByAuthor = new Map<string, number>();
    if (viewerFollowingIds.length > 0) {
      const secondDegreeRows = await this.access.rankingInput(
        viewerUserId,
        `secondDegree:${isPage1 ? 300 : 1000}:${stableJsonHash({ viewerFollowingIds, directNetworkExcludedIds, requestedAuthorUserIds })}`,
        () =>
          this.prisma.follow.findMany({
            where: {
              followerId: { in: viewerFollowingIds },
              followingId: requestedAuthorUserIds?.length
                ? {
                    in: requestedAuthorUserIds.filter(
                      (id) => !directNetworkExcludedIds.includes(id),
                    ),
                  }
                : { notIn: directNetworkExcludedIds },
            },
            select: { followingId: true },
            take: isPage1 ? 300 : 1000,
          }),
      );
      for (const row of secondDegreeRows) {
        const authorId = row.followingId;
        secondDegreePathCountByAuthor.set(
          authorId,
          (secondDegreePathCountByAuthor.get(authorId) ?? 0) + 1,
        );
      }
    }
    const secondDegreeAuthorIds = [...secondDegreePathCountByAuthor.entries()]
      .sort((a, b) => {
        if (b[1] !== a[1]) return b[1] - a[1];
        return a[0] < b[0] ? -1 : 1;
      })
      .slice(0, POSTS_RANKING.forYouSecondDegreeMaxAuthors)
      .map(([authorId]) => authorId);

    // Prefetch ID sets in parallel with the trending/chrono scan so followed-unseen
    // and friend-engaged lanes can use IN / NOT IN instead of correlated subqueries.
    const prefetchTake = Math.min(500, Math.max(scanTake + 1, scanTake * 3));
    const friendPrefetchNeeded = viewerFollowingIds.length > 0;
    const laneIdPrefetch = Promise.all([
      followingCandidateIds.length > 0 && viewerUserId
        ? this.prisma.postView.findMany({
            where: {
              userId: viewerUserId,
              post: {
                userId: { in: followingCandidateIds },
                createdAt: { gte: followedSince },
                deletedAt: null,
              },
            },
            select: { postId: true },
          })
        : Promise.resolve([] as Array<{ postId: string }>),
      friendPrefetchNeeded
        ? this.prisma.boost.findMany({
            where: { userId: { in: viewerFollowingIds } },
            select: { postId: true },
            orderBy: { createdAt: "desc" },
            take: prefetchTake,
          })
        : Promise.resolve([] as Array<{ postId: string }>),
      friendPrefetchNeeded
        ? this.prisma.post.findMany({
            where: {
              userId: { in: viewerFollowingIds },
              parentId: { not: null },
              deletedAt: null,
            },
            select: { parentId: true },
            orderBy: { createdAt: "desc" },
            take: prefetchTake,
          })
        : Promise.resolve([] as Array<{ parentId: string | null }>),
      friendPrefetchNeeded
        ? this.prisma.post.findMany({
            where: {
              userId: { in: viewerFollowingIds },
              kind: "repost",
              deletedAt: null,
              repostedPostId: { not: null },
            },
            select: { repostedPostId: true },
            orderBy: { createdAt: "desc" },
            take: prefetchTake,
          })
        : Promise.resolve([] as Array<{ repostedPostId: string | null }>),
    ]);

    if (!fallbackOnly) {
      const trendingCursorWhere: Prisma.PostWhereInput[] =
        cursorRow &&
        cursorRow.trendingScore != null &&
        cursorRow.trendingScore > 0
          ? [
              {
                OR: [
                  { trendingScore: { lt: cursorRow.trendingScore } },
                  {
                    AND: [
                      { trendingScore: cursorRow.trendingScore },
                      { createdAt: { lt: cursorRow.createdAt } },
                    ],
                  },
                  {
                    AND: [
                      { trendingScore: cursorRow.trendingScore },
                      { createdAt: cursorRow.createdAt },
                      { id: { lt: cursorRow.id } },
                    ],
                  },
                ],
              },
            ]
          : [];

      const recentTake = Math.max(1, Math.floor(scanTake / 2));
      const trendingTake = scanTake;
      const [tRows, cRows] = await Promise.all([
        this.prisma.post.findMany({
          where: {
            AND: [
              baseWhere,
              ...servedWhere,
              { trendingScore: { gt: 0 } },
              ...trendingCursorWhere,
            ],
          },
          orderBy: [
            { trendingScore: "desc" },
            { createdAt: "desc" },
            { id: "desc" },
          ],
          take: trendingTake + 1,
          select: {
            id: true,
            userId: true,
            parentId: true,
            communityGroupId: true,
            createdAt: true,
            trendingScore: true,
          },
        }),
        this.prisma.post.findMany({
          where: {
            AND: [
              baseWhere,
              ...servedWhere,
              { createdAt: { lte: new Date() } },
              ...(viewerUserId ? [{ views: { none: { userId: viewerUserId } } }] : []),
            ],
          },
          orderBy: [{ createdAt: "desc" }, { id: "desc" }],
          take: recentTake + 1,
          select: {
            id: true,
            userId: true,
            parentId: true,
            communityGroupId: true,
            createdAt: true,
            trendingScore: true,
          },
        }),
      ]);
      trendingScanned = tRows.slice(0, trendingTake);
      chronoScanned = cRows.slice(0, recentTake);
      discoveryOverflow =
        tRows.length > trendingTake || cRows.length > recentTake;
    } else {
      const chronoCursorWhere: Prisma.PostWhereInput[] = cursorRow
        ? [
            {
              OR: [
                { createdAt: { lt: cursorRow.createdAt } },
                {
                  AND: [
                    { createdAt: cursorRow.createdAt },
                    { id: { lt: cursorRow.id } },
                  ],
                },
              ],
            },
          ]
        : [];

      const cRows = (await this.prisma.post.findMany({
        where: {
          AND: [
            baseWhere,
            ...servedWhere,
            { OR: [{ trendingScore: 0 }, { trendingScore: null }] },
            ...chronoCursorWhere,
          ],
        },
        orderBy: [{ createdAt: "desc" }, { id: "desc" }],
        take: scanTake + 1,
        select: {
          id: true,
          userId: true,
          parentId: true,
          communityGroupId: true,
          createdAt: true,
          trendingScore: true,
        },
      })) as ForYouScannedRow[];

      const haveMoreChrono = cRows.length > scanTake;
      chronoScanned = cRows.slice(0, scanTake);
      discoveryOverflow = discoveryOverflow || haveMoreChrono;
    }

    const [
      viewedFromFollowed,
      friendBoostPrefetch,
      friendReplyPrefetch,
      friendRepostPrefetch,
    ] = await laneIdPrefetch;
    const viewedPostIds = [...new Set(viewedFromFollowed.map((r) => r.postId))];
    const friendEngagedPostIds = [
      ...new Set([
        ...friendBoostPrefetch.map((r) => r.postId),
        ...friendReplyPrefetch
          .map((r) => r.parentId)
          .filter((id): id is string => Boolean(id)),
        ...friendRepostPrefetch
          .map((r) => r.repostedPostId)
          .filter((id): id is string => Boolean(id)),
      ]),
    ];

    const friendTake = isPage1 ? Math.min(scanTake, limit) : scanTake;
    const secondDegreeTake = isPage1
      ? Math.min(scanTake, Math.max(5, Math.ceil(limit / 2)))
      : scanTake;
    const {
      candidateById,
      followedOverflow,
      friendOverflow,
      secondDegreeOverflow,
      memberGroupOverflow,
      openFollowGroupOverflow,
    } = await loadForYouNetworkCandidates({
      prisma: this.prisma,
      baseWhere,
      commonWhere,
      servedWhere,
      followingCandidateIds,
      viewedPostIds,
      friendEngagedPostIds,
      secondDegreeAuthorIds,
      memberGroupIds,
      viewerCanReadOpenGroups,
      followedSince,
      secondDegreeSince,
      groupSince,
      scanTake,
      friendTake,
      secondDegreeTake,
      secondDegreePathCountByAuthor,
      trendingScanned,
      chronoScanned,
    });

    if (viewerUserId && this.conversations) {
      const participated = await this.prisma.post.findMany({
        where: {
          userId: viewerUserId,
          parentId: { not: null },
          deletedAt: null,
          createdAt: { gte: engagedWithSince },
        },
        select: { rootId: true, parentId: true },
        orderBy: { createdAt: "desc" },
        take: 100,
      });
      const roots = [
        ...new Set(
          participated
            .map((p) => p.rootId ?? p.parentId)
            .filter((id): id is string => !!id),
        ),
      ];
      const linkedUpdates = await this.prisma.post.findMany({
        where: {
          AND: [
            baseWhere,
            ...servedWhere,
            {
              parentId: null,
              createdAt: { gte: followedSince },
              quotedPost: {
                OR: [
                  { boosts: { some: { userId: viewerUserId } } },
                  { bookmarks: { some: { userId: viewerUserId } } },
                  {
                    replies: {
                      some: { userId: viewerUserId, deletedAt: null },
                    },
                  },
                  {
                    threadReplies: {
                      some: { userId: viewerUserId, deletedAt: null },
                    },
                  },
                ],
              },
            },
          ],
        },
        select: {
          id: true,
          userId: true,
          parentId: true,
          communityGroupId: true,
          createdAt: true,
          trendingScore: true,
          quotedPost: { select: { userId: true } },
        },
        orderBy: [{ createdAt: "desc" }, { id: "desc" }],
        take: 20,
      });
      addForYouRows(candidateById, secondDegreePathCountByAuthor,
        linkedUpdates.filter((p) => p.quotedPost?.userId === p.userId),
        "discovery",
      );

      if (roots.length) {
        const readable = await this.conversations.readableWhere(viewerUserId);
        const active = await this.prisma.post.findMany({
          where: {
            AND: [
              baseWhere,
              ...servedWhere,
              {
                id: { in: roots },
                replies: {
                  some: {
                    AND: [
                      readable,
                      {
                        createdAt: { gte: followedSince },
                        userId: { not: viewerUserId },
                        body: { not: "" },
                      },
                    ],
                  },
                },
              },
            ],
          },
          select: {
            id: true,
            userId: true,
            parentId: true,
            communityGroupId: true,
            createdAt: true,
            trendingScore: true,
          },
          take: 20,
        });
        addForYouRows(candidateById, secondDegreePathCountByAuthor,active, "discovery");
      }
    }
    const candidates = [...candidateById.values()];
    if (candidates.length === 0) {
      const fallback = await fetchChronologicalMediaFallback(limit, []);
      if (fallback.posts.length > 0) {
        const fallbackIds = fallback.posts.map((p) => p.id);
        return {
          posts: fallback.posts,
          nextCursor: fallback.overflow
            ? await this.access.encodeForYouCursor(
                [...servedIds, ...fallbackIds],
                jitterSeed,
                viewerUserId,
              )
            : null,
          scoreByPostId: new Map(fallbackIds.map((id) => [id, 0])),
        };
      }
      return { posts: [], nextCursor: null, scoreByPostId: new Map() };
    }

    const candidateIds = candidates.map((c) => c.id);
    const conversationContexts =
      viewerUserId && this.conversations
        ? await this.conversations.contexts(viewerUserId, candidateIds)
        : new Map();
    const authorIds = [...new Set(candidates.map((c) => c.userId))];
    const friendEngagedIds = candidates
      .filter((c) => c.friendEngaged)
      .map((c) => c.id);

    const [
      followerRows,
      viewedRows,
      friendEngagementRows,
      viewerBoostRows,
      viewerReplyRows,
    ] = await Promise.all([
      // Who follows the viewer — used for mutual-follow scoring. Skip when anonymous.
      viewerUserId
        ? this.prisma.follow.findMany({
            where: { followingId: viewerUserId, followerId: { in: authorIds } },
            select: { followerId: true },
          })
        : Promise.resolve([] as Array<{ followerId: string }>),
      // Viewer's post-view history — used for seen-decay scoring. Skip when anonymous (no last-seen).
      viewerUserId
        ? this.prisma.postView.findMany({
            where: { userId: viewerUserId, postId: { in: candidateIds } },
            select: {
              postId: true,
              createdAt: true,
              lastSeenAt: true,
              seenCount: true,
              lastSource: true,
            },
          })
        : Promise.resolve(
            [] as Array<{
              postId: string;
              createdAt: Date;
              lastSeenAt: Date | null;
              seenCount: bigint | number | null;
              lastSource: string | null;
            }>,
          ),
      // Aggregate in SQL so prolific friends cannot inflate proof or response size.
      friendEngagedIds.length > 0 && viewerFollowingIds.length > 0
        ? this.prisma.$queryRaw<
            Array<{ postId: string; people: number; latestAt: Date }>
          >(friendEngagementSql(friendEngagedIds, viewerFollowingIds))
        : Promise.resolve(
            [] as Array<{ postId: string; people: number; latestAt: Date }>,
          ),
      // Viewer's own recent boosts — used to identify A+ tier authors (people you actively engage with).
      // Boost has @@unique([postId, userId]) so _count is effectively distinct users.
      viewerUserId
        ? this.access.rankingInput(viewerUserId, "engagedBoostAuthors", () =>
            this.prisma.boost.findMany({
              where: {
                userId: viewerUserId,
                createdAt: { gte: engagedWithSince },
              },
              select: { post: { select: { userId: true } } },
              take: 200,
            }),
          )
        : Promise.resolve([] as Array<{ post: { userId: string } }>),
      // Viewer's own recent replies — surfaces authors the viewer actively talks to.
      viewerUserId
        ? this.access.rankingInput(viewerUserId, "engagedReplyAuthors", () =>
            this.prisma.post.findMany({
              where: {
                userId: viewerUserId,
                parentId: { not: null },
                createdAt: { gte: engagedWithSince },
              },
              select: { parent: { select: { userId: true } } },
              take: 200,
            }),
          )
        : Promise.resolve([] as Array<{ parent: { userId: string } | null }>),
    ]);

    const youFollow = new Set(viewerFollowingIds);
    const followsYou = new Set(followerRows.map((r) => r.followerId));

    // A+ tier: authors the viewer has recently boosted or replied to (explicit engagement history).
    const engagedWithAuthorIds = new Set<string>([
      ...viewerBoostRows.map((r) => r.post.userId).filter(Boolean),
      ...viewerReplyRows
        .map((r) => r.parent?.userId)
        .filter((id): id is string => Boolean(id)),
    ]);

    const socialProofCountById = new Map(
      friendEngagementRows.map((r) => [r.postId, Number(r.people)]),
    );

    const seenById = new Map<
      string,
      { lastSeenAt: Date; seenCount: number; lastSource: string | null }
    >(
      viewedRows.map((r) => [
        r.postId,
        {
          lastSeenAt: r.lastSeenAt ?? r.createdAt,
          seenCount: Math.max(1, Math.floor(Number(r.seenCount ?? 1))),
          lastSource: r.lastSource ?? null,
        },
      ]),
    );

    const lastFriendEngagementAt = new Map(
      friendEngagementRows.map((r) => [r.postId, r.latestAt]),
    );
    for (const c of candidates) {
      if (c.friendEngaged) {
        c.lastFriendEngagementAt = lastFriendEngagementAt.get(c.id) ?? null;
      }
    }

    const now = Date.now();
    // Score without jitter first: jitter strength depends on how saturated the resulting page
    // is, which we can only know once the candidates are ordered.
    const scored = candidates.map((c) => {
      const conversation = conversationContexts.get(c.id);
      const youFollowThem = youFollow.has(c.userId);
      const theyFollowYou = followsYou.has(c.userId);
      const youEngagedWithThem =
        youFollowThem && engagedWithAuthorIds.has(c.userId);
      // Relationship tiers (A+ > A > B > E > C > D):
      //   A+ (2.0) — you follow them AND recently boosted/replied to their content
      //   A  (1.8) — mutual follow
      //   B  (1.1) — you follow them
      //   E  (0.85) — friend engaged, but you don't follow the author
      //   C  (0.65) — they follow you (no friend engagement)
      //   D  (0.15) — no relationship
      const relMult = youEngagedWithThem
        ? POSTS_RANKING.forYouRelMultEngaged
        : youFollowThem && theyFollowYou
          ? POSTS_RANKING.forYouRelMultMutual
          : youFollowThem
            ? POSTS_RANKING.forYouRelMultFollowing
            : c.friendEngaged
              ? POSTS_RANKING.forYouFriendCommentedMult
              : theyFollowYou
                ? POSTS_RANKING.forYouRelMultFollower
                : POSTS_RANKING.forYouRelMultStranger;

      const seen = seenById.get(c.id);
      const seenHoursAgo = seen
        ? Math.max(0, (now - seen.lastSeenAt.getTime()) / (60 * 60 * 1000))
        : Number.POSITIVE_INFINITY;
      let seenMult = 1.0;
      if (seen) {
        const hours = seenHoursAgo;
        const recovery =
          1 - Math.exp(-hours / POSTS_RANKING.forYouSeenHalfLifeHours);
        seenMult =
          POSTS_RANKING.forYouSeenFloor +
          (1 - POSTS_RANKING.forYouSeenFloor) * recovery;
        if (seen.seenCount > 1) {
          const repeatPenalty =
            1 /
            (1 +
              Math.log2(seen.seenCount) *
                POSTS_RANKING.forYouSeenRepeatPenaltyStrength);
          seenMult *= repeatPenalty;
        }
        if (
          seen.lastSource === "feed_scroll" &&
          hours < POSTS_RANKING.forYouRecentFeedSeenExtraPenaltyHours
        ) {
          seenMult *= POSTS_RANKING.forYouRecentFeedSeenExtraPenaltyMult;
        }
      }

      // Only compound the 2.2x bonus when you already follow the author (tiers A/B). For the
      // E tier (friend engaged, stranger/follower author) the social proof is fully captured in
      // forYouFriendCommentedMult — stacking would over-reward the same signal twice.
      const friendMult =
        c.friendEngaged && youFollowThem
          ? POSTS_RANKING.forYouFriendEngagementMult
          : 1.0;
      const followedUnseenMult = c.followingUnseen
        ? POSTS_RANKING.forYouFollowedUnseenMult
        : 1.0;
      const secondDegreePathBonus = c.secondDegree
        ? Math.min(
            POSTS_RANKING.forYouSecondDegreePathBonusMax,
            1 + Math.max(0, c.secondDegreePaths - 1) * 0.15,
          )
        : 1.0;
      const secondDegreeMult = c.secondDegree
        ? POSTS_RANKING.forYouSecondDegreeMult * secondDegreePathBonus
        : 1.0;
      const groupMult = c.memberGroup
        ? POSTS_RANKING.forYouMemberGroupMult
        : c.openFollowGroup
          ? POSTS_RANKING.forYouOpenFollowGroupMult
          : 1.0;
      // Effective age uses the freshest of (post createdAt, latest friend engagement) — a months-old
      // post with a 2h-ago reply from someone the viewer follows ranks like fresh content.
      const friendEngagementMs = c.lastFriendEngagementAt?.getTime() ?? 0;
      const effectiveAtMs = Math.max(
        c.createdAt.getTime(),
        friendEngagementMs,
        conversation?.reply ? Date.parse(conversation.reply.createdAt) : 0,
      );
      const ageHours = Math.max(0, (now - effectiveAtMs) / (60 * 60 * 1000));
      const decay =
        POSTS_RANKING.forYouRecencyFloor +
        (1 - POSTS_RANKING.forYouRecencyFloor) *
          Math.exp(-ageHours / POSTS_RANKING.forYouRecencyHalfLifeHours);
      const freshBoost =
        ageHours < 24
          ? POSTS_RANKING.forYouFreshBoost24h
          : ageHours < 48
            ? POSTS_RANKING.forYouFreshBoost48h
            : ageHours < 72
              ? POSTS_RANKING.forYouFreshBoost72h
              : 1.0;
      const recencyMult = decay * freshBoost;
      const replyMult = c.parentId ? POSTS_RANKING.forYouReplyMult : 1.0;

      // Base score is user-first, not content-first:
      //   - Friend-engaged: social proof (N follows who engaged × weight) dominates over global trending,
      //     so a post engaged by 3 of your follows outranks a viral post with zero social connection.
      //   - Pure discovery (no social connection to author + no second-degree/group signal): global
      //     trending is demoted 40% so strangers' viral content doesn't crowd out social posts.
      //     We check the RELATIONSHIP (youFollowThem/theyFollowYou), not lane flags, because a seen
      //     post from a followed author only enters via trending scan (followingUnseen=false) but still
      //     has a social connection and must NOT be demoted.
      //   - All other cases (author in social graph, second-degree, groups): use trendingScore as-is.
      const rawTrending = 1 + Math.max(0, c.trendingScore ?? 0);
      const socialProofCount = Math.min(
        POSTS_RANKING.forYouSocialProofMaxPeople,
        socialProofCountById.get(c.id) ?? 0,
      );
      const noSocialConnection =
        !youFollowThem &&
        !theyFollowYou &&
        !c.secondDegree &&
        !c.memberGroup &&
        !c.openFollowGroup;
      let rawBase: number;
      if (c.friendEngaged) {
        const socialBase =
          socialProofCount * POSTS_RANKING.forYouSocialProofBaseWeight;
        rawBase = Math.max(socialBase, rawTrending);
      } else if (noSocialConnection) {
        rawBase = rawTrending * 0.4;
      } else {
        rawBase = rawTrending;
      }
      const conversationBonus =
        conversation?.kind === "unanswered"
          ? 1.5
          : conversation?.kind === "newReplies"
            ? 3
            : conversation?.kind === "followUp"
              ? 1
              : 0;
      const base =
        conversationBonus +
        (c.friendEngaged
          ? Math.max(rawBase, POSTS_RANKING.forYouFriendEngagementBaseFloor)
          : rawBase);
      // A pull-to-refresh is the viewer saying "I've read these". The ordinary seen decay
      // recovers over days, which is the right call for a passive reload but far too slow for
      // a deliberate refresh, so hand those slots to unseen candidates.
      const refreshSeenMult =
        isRefreshPage &&
        seenHoursAgo < POSTS_RANKING.forYouRefreshSeenDemotionHours
          ? POSTS_RANKING.forYouRefreshSeenDemotionMult
          : 1.0;
      const unjittered =
        base *
        recencyMult *
        relMult *
        seenMult *
        friendMult *
        followedUnseenMult *
        secondDegreeMult *
        groupMult *
        replyMult *
        refreshSeenMult;
      return { candidate: c, unjittered, seen: Boolean(seen) };
    });

    // Saturation: how much of the page the viewer would actually be served has it already
    // seen. Measuring the whole candidate pool understates this badly — the discovery scan is
    // mostly low-scoring posts that never reach the page, so the pool reads as fresh while
    // every visible row is something the viewer read hours ago, and the reshuffle that exists
    // for exactly that case never engages.
    const servedSlice = [...scored]
      .sort((a, b) => b.unjittered - a.unjittered)
      .slice(0, limit);
    const saturation = servedSlice.length
      ? servedSlice.filter((r) => r.seen).length / servedSlice.length
      : 0;
    const saturationRamp = Math.max(
      0,
      (saturation - POSTS_RANKING.forYouSeenSaturationJitterThreshold) /
        (1 - POSTS_RANKING.forYouSeenSaturationJitterThreshold),
    );

    // Anon always jitters (no seen-history). Authed first paint stays deterministic for unseen
    // rows; pull-to-refresh uses a floor so a new seed actually moves the page.
    const refreshJitterFloor = isRefreshPage
      ? POSTS_RANKING.forYouRefreshJitterFloor
      : 0;
    const jitterStrengthBase =
      viewerUserId == null
        ? POSTS_RANKING.forYouAnonJitterStrength
        : Math.max(POSTS_RANKING.forYouSeenJitterBase, refreshJitterFloor);
    const jitterStrength = Math.min(
      1,
      jitterStrengthBase +
        (POSTS_RANKING.forYouSeenSaturationJitterMax - jitterStrengthBase) *
          saturationRamp,
    );

    // Saturation jitter reshuffles already-seen rows so a "seen everything" refresh is not
    // identical. Unseen authed posts keep only the refresh/anon floor — otherwise ±90% jitter
    // can bury a brand-new discovery item under a just-seen trending post.
    const ranked = scored.map(({ candidate, unjittered, seen }) => {
      const postJitterStrength =
        seen || viewerUserId == null ? jitterStrength : jitterStrengthBase;
      const jitter =
        1 +
        (seededUnitInterval(jitterSeed, candidate.id) * 2 - 1) *
          postJitterStrength;
      return { candidate, adjusted: unjittered * jitter };
    });

    ranked.sort((a, b) => {
      if (b.adjusted !== a.adjusted) return b.adjusted - a.adjusted;
      if (a.candidate.followingUnseen !== b.candidate.followingUnseen)
        return a.candidate.followingUnseen ? -1 : 1;
      if (a.candidate.friendEngaged !== b.candidate.friendEngaged)
        return a.candidate.friendEngaged ? -1 : 1;
      const aBase = a.candidate.trendingScore ?? 0;
      const bBase = b.candidate.trendingScore ?? 0;
      if (bBase !== aBase) return bBase - aBase;
      const at = a.candidate.createdAt.getTime();
      const bt = b.candidate.createdAt.getTime();
      if (bt !== at) return bt - at;
      return a.candidate.id < b.candidate.id ? 1 : -1;
    });

    // Freshness is a priority tier, never just a multiplier: a very popular seen
    // board must not displace an unseen candidate. Diversity is relaxed within
    // each tier before advancing to the next one.
    // Depth-aware quota: the feed fans out from user-first toward social discovery as the viewer
    // scrolls deeper. servedIds.length is the number of posts already served in this session.
    const paginationDepth = servedIds.length;
    const followedUnseenRatio =
      paginationDepth === 0
        ? 0.7 // page 1: strongly user-first (people you follow dominate)
        : paginationDepth <= 50
          ? 0.55 // page 2: still follow-heavy but opens discovery
          : 0.4; // page 3+: fans out into friend-engaged + second-degree
    const followedQuota = Math.min(
      limit,
      Math.ceil(limit * followedUnseenRatio),
    );
    // The followed-unseen quota is the "tippy top" of the feed. Order it by recency bucket with
    // preference for authors the viewer actively engages with, then mutuals, then recency.
    // Using `ranked`'s `adjusted` score here would bury a brand-new follow post under older
    // follow posts that already accumulated trendingScore — the viewer would refresh and not
    // see the post their friend just sent.
    const bucketHours = POSTS_RANKING.forYouFollowedQuotaBucketHours;
    const followedUnseenSorted = ranked
      .filter((r) => r.candidate.followingUnseen)
      .slice()
      .sort((a, b) => {
        const aAgeH = Math.max(
          0,
          (now - a.candidate.createdAt.getTime()) / (60 * 60 * 1000),
        );
        const bAgeH = Math.max(
          0,
          (now - b.candidate.createdAt.getTime()) / (60 * 60 * 1000),
        );
        const aBucket = Math.floor(aAgeH / bucketHours);
        const bBucket = Math.floor(bAgeH / bucketHours);
        if (aBucket !== bBucket) return aBucket - bBucket;
        // Within bucket: engaged-with authors first (A+ tier), then mutuals (A), then one-way.
        const aEngaged = engagedWithAuthorIds.has(a.candidate.userId);
        const bEngaged = engagedWithAuthorIds.has(b.candidate.userId);
        if (aEngaged !== bEngaged) return aEngaged ? -1 : 1;
        const aMutual =
          youFollow.has(a.candidate.userId) &&
          followsYou.has(a.candidate.userId);
        const bMutual =
          youFollow.has(b.candidate.userId) &&
          followsYou.has(b.candidate.userId);
        if (aMutual !== bMutual) return aMutual ? -1 : 1;
        return (
          b.candidate.createdAt.getTime() - a.candidate.createdAt.getTime()
        );
      });
    // The followed-unseen preference is identical on reload and explicit refresh.
    const preferred = followedUnseenSorted.slice(0, followedQuota);
    const preferredIds = new Set(preferred.map((r) => r.candidate.id));
    const picked = selectFreshForYou([...preferred, ...ranked.filter((r) => !preferredIds.has(r.candidate.id))], {
      limit,
      seenById,
      hasNewReplies: (id) => conversationContexts.get(id)?.kind === "newReplies",
      authorWindow: POSTS_RANKING.forYouMaxPerAuthorWindow,
    });
    const pickedIdSet = new Set(picked.map((row) => row.candidate.id));

    const pickedIds = picked.map((p) => p.candidate.id);
    const posts = pickedIds.length
      ? ((await this.prisma.post.findMany({
          where: { id: { in: pickedIds }, ...notDeletedWhere() },
          include: params.mediaOnly ? mediaFeedPostInclude : feedPostInclude,
        })) as FeedPost[])
      : [];
    const byId = new Map(posts.map((p) => [p.id, p] as const));
    let ordered = pickedIds
      .map((id) => byId.get(id))
      .filter((p): p is FeedPost => Boolean(p));
    const fallback = await fetchChronologicalMediaFallback(
      limit - ordered.length,
      pickedIds,
    );
    if (fallback.posts.length > 0) {
      ordered = [...ordered, ...fallback.posts];
    }
    const orderedIds = ordered.map((p) => p.id);

    const moreAvailable =
      ranked.some((r) => !pickedIdSet.has(r.candidate.id)) ||
      followedOverflow ||
      friendOverflow ||
      secondDegreeOverflow ||
      memberGroupOverflow ||
      openFollowGroupOverflow ||
      discoveryOverflow ||
      fallback.overflow;
    const nextCursor = moreAvailable
      ? await this.access.encodeForYouCursor(
          [...servedIds, ...orderedIds],
          jitterSeed,
          viewerUserId,
        )
      : null;

    const scoreByPostId = new Map<string, number>(
      picked.map((p) => [p.candidate.id, p.adjusted]),
    );
    for (const post of fallback.posts) scoreByPostId.set(post.id, 0);

    return { posts: ordered, nextCursor, scoreByPostId };
  }
}
