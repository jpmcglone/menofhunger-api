import { NOT_BANNED_USER_WHERE } from '../../common/prisma-selects/user.where';
import { ConversationsService } from "./conversations.service";
import { ForbiddenException, Injectable } from "@nestjs/common";
import { Prisma, type PostVisibility } from "@prisma/client";
import { PrismaService } from "../prisma/prisma.service";
import { ViewerContextService } from "../viewer/viewer-context.service";
import { friendEngagementSql } from "./posts-friend-engagement.sql";
import { POSTS_RANKING } from "./posts-ranking.config";
import { generateRandomSeed } from "../../common/random/seeded-random";
import { excludeCommunityGroupPostsWhere, mediaOnlyWhere, notDeletedWhere } from "./posts-query-builders";
import { feedPostInclude, mediaFeedPostInclude, type FeedPost, type PopularFeedResult } from "./posts-feed.types";
import { PostsViewerEnrichmentService } from "./posts-viewer-enrichment.service";
import { CacheService } from "../redis/cache.service";
import { CacheInvalidationService } from "../redis/cache-invalidation.service";
import { CacheTtl } from "../redis/cache-ttl";
import { RedisKeys, stableJsonHash } from "../redis/redis-keys";
import { PostsFeedAccessService } from "./posts-feed-access.service";
import { rankAndPickForYou, scoreForYouCandidates } from "./posts-feed-for-you-scoring";
import { addForYouRows, loadForYouNetworkCandidates, type ForYouScannedRow } from "./posts-feed-for-you-lanes";
import { toPage } from '../../common/pagination/page';
import { createdAtIdBefore } from '../../common/pagination/created-at-id-cursor';
import { NOT_DELETED } from '../../common/prisma/where';

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
    private readonly conversations: ConversationsService,
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
      ...NOT_DELETED,
      ...(kind ? { kind } : {}),
      user: NOT_BANNED_USER_WHERE,
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
      const { items: pagePosts, nextCursor } = toPage(rows, take, (r) => r.id);
      return { posts: pagePosts, overflow: nextCursor !== null };
    };

    // Keep legacy popular cursor support for users who loaded page one before this deploy.
    const legacyCursor = decodedForYouCursor.legacyPopular;
    const cursorRow = legacyCursor
      ? await this.prisma.post.findFirst({
          where: { id: legacyCursor.id, ...NOT_DELETED },
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
                ...NOT_DELETED,
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
              ...NOT_DELETED,
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
              ...NOT_DELETED,
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
            createdAtIdBefore({ createdAt: cursorRow.createdAt, id: cursorRow.id }),
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
          ...NOT_DELETED,
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
                      some: { userId: viewerUserId, ...NOT_DELETED },
                    },
                  },
                  {
                    threadReplies: {
                      some: { userId: viewerUserId, ...NOT_DELETED },
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
    const scored = scoreForYouCandidates({
      candidates,
      conversationContexts,
      youFollow,
      followsYou,
      engagedWithAuthorIds,
      socialProofCountById,
      seenById,
      now,
      isRefreshPage,
    });

    const { ranked, picked } = rankAndPickForYou({
      scored,
      limit,
      isAnonymous: viewerUserId == null,
      isRefreshPage,
      jitterSeed,
      servedCount: servedIds.length,
      now,
      youFollow,
      followsYou,
      engagedWithAuthorIds,
      seenById,
      conversationContexts,
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
