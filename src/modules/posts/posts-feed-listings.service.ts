import {ConversationsService} from "./conversations.service";
import {
  ForbiddenException,
  Injectable,
  NotFoundException,
} from "@nestjs/common";
import {Prisma} from "@prisma/client";
import type {
  PostVisibility,
} from "@prisma/client";
import {PrismaService} from "../prisma/prisma.service";
import {RequestCacheService} from "../../common/cache/request-cache.service";
import {
  ViewerContextService,
} from "../viewer/viewer-context.service";
import {AppConfigService} from "../app/app-config.service";
import {buildPostVisibilityWhere} from "../../common/posts/post-visibility";
import {createdAtIdCursorWhere} from "../../common/pagination/created-at-id-cursor";
import {toCommunityGroupPreviewDto} from "../../common/dto/community-group.dto";
import type {CommunityGroupPreviewDto} from "../../common/dto/community-group.dto";
import {collectAncestorPostIds} from "../../common/posts/collect-ancestor-post-ids";
import {loadPostVideoEmbeds} from "../../common/posts/post-video-embeds";
import {
  collapseFeedByRoot,
  type FeedCollapsedItem,
} from "../../common/feed-collapse/collapse-by-root";
import {applyCollapsedThreadSummary} from "../../common/feed-collapse/collapsed-thread-summary";
import {collapseRepostsByCanonical} from "../../common/feed-collapse/collapse-reposts-by-canonical";
import {
  toPostDto,
  toPostAuthorDtoFromFeedRow,
  type PostAuthorDto,
  type PostDto,
} from "../../common/dto/post.dto";
import {buildAttachParentChain, postChainInvolvesAuthor} from "./posts.utils";
import {
  excludeCommunityGroupPostsWhere,
  mediaOnlyWhere,
  notDeletedWhere,
  userNotBannedWhere,
} from "./posts-query-builders";
import {
  feedPostInclude,
  mediaFeedPostInclude,
  type FeedPost,
  type FeedResult,
} from "./posts-feed.types";
import {PostsViewerEnrichmentService} from "./posts-viewer-enrichment.service";
import {PostsRankingService} from "./posts-ranking.service";
import {CommunityGroupReadAccessService} from "../viewer/community-group-read-access.service";
import {PostsFeedAccessService} from "./posts-feed-access.service";

@Injectable()
export class PostsFeedListingsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly requestCache: RequestCacheService,
    private readonly viewerContextService: ViewerContextService,
    private readonly appConfig: AppConfigService,
    private readonly enrichment: PostsViewerEnrichmentService,
    private readonly ranking: PostsRankingService,
    private readonly groupReadAccess: CommunityGroupReadAccessService,
    private readonly access: PostsFeedAccessService,
    private readonly conversations: ConversationsService = undefined!,
  ) {}
  async listOnlyMe(params: {
    userId: string;
    limit: number;
    cursor: string | null;
  }) {
    const { userId, limit, cursor } = params;

    const cursorWhere = await createdAtIdCursorWhere({
      cursor,
      lookup: async (id) =>
        await this.prisma.post.findUnique({
          where: { id },
          select: { id: true, createdAt: true },
        }),
    });

    const posts = await this.prisma.post.findMany({
      where: {
        AND: [
          {
            userId,
            visibility: "onlyMe",
            parentId: null,
            isDraft: false,
            ...notDeletedWhere(),
          },
          ...(cursorWhere ? [cursorWhere] : []),
        ],
      },
      include: feedPostInclude,
      orderBy: [{ createdAt: "desc" }, { id: "desc" }],
      take: limit + 1,
    });

    const slice = posts.slice(0, limit);
    const nextCursor =
      posts.length > limit ? (slice[slice.length - 1]?.id ?? null) : null;
    return { posts: slice, nextCursor };
  }

  async listFeed(params: {
    viewerUserId: string | null;
    limit: number;
    cursor: string | null;
    visibility: "all" | PostVisibility;
    followingOnly: boolean;
    kind?: "regular" | "checkin" | null;
    checkinDayKey?: string | null;
    /** When true, include the viewer's own posts (overrides home-feed self-exclusion). */
    includeSelf?: boolean;
    mediaOnly?: boolean;
    topLevelOnly?: boolean;
    authorUserIds?: string[] | null;
    /** Filter to posts whose author has a matching US state code (e.g. "VA"). */
    authorLocationState?: string | null;
  }): Promise<FeedResult> {
    const { viewerUserId, limit, cursor, visibility, followingOnly } = params;
    const authorUserIds =
      (params.authorUserIds ?? null)
        ?.map((s) => (s ?? "").trim())
        .filter(Boolean) ?? null;
    const authorLocationState =
      (params.authorLocationState ?? "").trim() || null;
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
      return { posts: [], nextCursor: null };
    }

    // Author always sees own posts (e.g. after tier downgrade); others filtered by allowed visibility.
    const baseVisibility =
      visibility === "all"
        ? ({ visibility: { in: allowed } } as Prisma.PostWhereInput)
        : visibility === "public"
          ? ({ visibility: "public" } as Prisma.PostWhereInput)
          : ({ visibility } as Prisma.PostWhereInput);

    // IMPORTANT: Only apply "author sees own posts" override when visibility='all'.
    // When user explicitly filters by a specific visibility, respect that filter even for their own posts.
    const visibilityWhere =
      viewerUserId && visibility === "all"
        ? buildPostVisibilityWhere({ viewerUserId, allowed, authorOverride: "excludeOnlyMe" })
        : baseVisibility;

    if (authorUserIds && authorUserIds.length === 0) {
      return { posts: [], nextCursor: null };
    }

    // Group posts are excluded from all home feeds; they appear only on the group wall
    // and permalink (/p/:id). The Groups badge is the primary signal for new group activity.
    const communityScopeWhere: Prisma.PostWhereInput =
      excludeCommunityGroupPostsWhere();

    // Exclude the viewer's own posts from home feeds (Following + All) unless the feed
    // is explicitly scoped to a set of author IDs (e.g. profile view, crew feed),
    // or the caller explicitly opts in with includeSelf (e.g. per-day check-in feeds).
    const excludeSelfWhere: Prisma.PostWhereInput[] =
      viewerUserId && !authorUserIds?.length && !params.includeSelf
        ? ([{ NOT: { userId: viewerUserId } }] as Prisma.PostWhereInput[])
        : [];

    const locationStateWhere: Prisma.PostWhereInput[] = authorLocationState
      ? ([
          { user: { locationState: authorLocationState } },
        ] as Prisma.PostWhereInput[])
      : [];
    const mutedIds = authorUserIds?.length
      ? []
      : await this.access.viewerMutedIds(viewerUserId);
    if (mutedIds.length) excludeSelfWhere.push({ userId: { notIn: mutedIds } });

    const where = followingOnly
      ? {
          AND: [
            visibilityWhere,
            notDeletedWhere(),
            communityScopeWhere,
            userNotBannedWhere(),
            ...(kind ? ([{ kind }] as Prisma.PostWhereInput[]) : []),
            ...(checkinDayKey
              ? ([{ checkinDayKey }] as Prisma.PostWhereInput[])
              : []),
            ...(params.mediaOnly ? [mediaOnlyWhere()] : []),
            ...(params.topLevelOnly
              ? ([{ parentId: null }] as Prisma.PostWhereInput[])
              : []),
            ...(authorUserIds?.length
              ? ([{ userId: { in: authorUserIds } }] as Prisma.PostWhereInput[])
              : []),
            ...locationStateWhere,
            ...excludeSelfWhere,
            {
              user: {
                followers: { some: { followerId: viewerUserId as string } },
              },
            },
          ],
        }
      : {
          AND: [
            visibilityWhere,
            notDeletedWhere(),
            communityScopeWhere,
            userNotBannedWhere(),
            ...(kind ? ([{ kind }] as Prisma.PostWhereInput[]) : []),
            ...(checkinDayKey
              ? ([{ checkinDayKey }] as Prisma.PostWhereInput[])
              : []),
            ...(params.mediaOnly ? [mediaOnlyWhere()] : []),
            ...(params.topLevelOnly
              ? ([{ parentId: null }] as Prisma.PostWhereInput[])
              : []),
            ...(authorUserIds?.length
              ? ([{ userId: { in: authorUserIds } }] as Prisma.PostWhereInput[])
              : []),
            ...locationStateWhere,
            ...excludeSelfWhere,
          ],
        };

    const cursorWhere = await createdAtIdCursorWhere({
      cursor,
      lookup: async (id) =>
        await this.prisma.post.findUnique({
          where: { id },
          select: { id: true, createdAt: true },
        }),
    });
    const whereWithCursor = cursorWhere
      ? ({ AND: [where, cursorWhere] } as Prisma.PostWhereInput)
      : where;
    const include = params.mediaOnly ? mediaFeedPostInclude : feedPostInclude;

    const posts = (await this.prisma.post.findMany({
      where: whereWithCursor,
      include,
      orderBy: [{ createdAt: "desc" }, { id: "desc" }],
      take: limit + 1,
    })) as FeedPost[];

    const slice = posts.slice(0, limit);
    const nextCursor =
      posts.length > limit ? (slice[slice.length - 1]?.id ?? null) : null;

    return { posts: slice, nextCursor };
  }

  async listActiveCommunityGroupIdsForUser(
    viewerUserId: string,
  ): Promise<string[]> {
    const rows = await this.prisma.communityGroupMember.findMany({
      where: { userId: viewerUserId, status: "active" },
      select: { groupId: true },
    });
    return rows.map((r) => r.groupId);
  }

  /**
   * Read-access gate for a community group's post feed.
   *   • OPEN groups: any signed-in, verified viewer may read.
   *   • PRIVATE (approval) groups: active members only (site admins always allowed).
   * Composer / write paths use their own membership check — do not call this
   * from those paths.
   */
  async assertCanReadCommunityGroup(
    viewerUserId: string | null,
    groupId: string,
  ): Promise<void> {
    return this.groupReadAccess.assertCanRead(viewerUserId, groupId);
  }

  /**
   * Timeline posts inside one or more community groups (roots + replies by default).
   * When `topLevelOnly` is true, only root posts (`parentId IS NULL`) are returned.
   * When `applyPinnedHead` and a single group, the owner-pinned root post is prepended on the first chronological page only.
   */
  async listCommunityGroupsTimelinePosts(params: {
    groupIds: string[];
    limit: number;
    cursor: string | null;
    sort: "new" | "trending";
    applyPinnedHead: boolean;
    topLevelOnly?: boolean;
    allowedVisibilities: PostVisibility[];
  }): Promise<FeedResult> {
    const { groupIds, limit, cursor, sort } = params;
    if (groupIds.length === 0) return { posts: [], nextCursor: null };

    const groupWhere: Prisma.PostWhereInput =
      groupIds.length === 1
        ? { communityGroupId: groupIds[0]! }
        : { communityGroupId: { in: groupIds } };

    const topLevelFilter: Prisma.PostWhereInput = params.topLevelOnly
      ? { parentId: null }
      : {};

    const applyPin =
      Boolean(
        params.applyPinnedHead &&
        sort === "new" &&
        !cursor &&
        groupIds.length === 1,
      ) && groupIds[0];

    let pinned: FeedPost | null = null;
    let pinnedId: string | null = null;
    if (applyPin && groupIds[0]) {
      const p = await this.prisma.post.findFirst({
        where: {
          communityGroupId: groupIds[0],
          parentId: null,
          ...notDeletedWhere(),
          pinnedInGroupAt: { not: null },
          visibility: { in: params.allowedVisibilities },
        },
        orderBy: { pinnedInGroupAt: "desc" },
        include: feedPostInclude,
      });
      pinned = p as FeedPost | null;
      pinnedId = pinned?.id ?? null;
    }

    const takeMain = pinnedId && !cursor ? Math.max(1, limit - 1) : limit;

    const baseAnd: Prisma.PostWhereInput[] = [
      groupWhere,
      notDeletedWhere(),
      userNotBannedWhere(),
      { visibility: { in: params.allowedVisibilities } },
    ];
    if (pinnedId) baseAnd.push({ id: { not: pinnedId } });
    if (params.topLevelOnly) baseAnd.push(topLevelFilter);

    if (sort === "trending") {
      // Two-phase trending feed:
      //   1. Trending head: posts with trendingScore > 0, ordered by score then recency.
      //   2. Chronological tail: when trending doesn't fill the page (sparse engagement,
      //      brand-new group, popular-score cron behind, etc.), supplement with the most
      //      recent unscored posts so the surface never shows fewer rows than the page size.
      // Pagination mode is encoded in the cursor row's trendingScore: a null/zero score
      // means "we're past the trending head, continue chronologically on the next page."
      const cursorRow = cursor
        ? await this.prisma.post.findFirst({
            where: { id: cursor, ...groupWhere, ...notDeletedWhere() },
            select: { id: true, createdAt: true, trendingScore: true },
          })
        : null;
      const fallbackOnly =
        Boolean(cursor) && (!cursorRow || cursorRow.trendingScore == null);

      // Chronological-tail filter: only rows that DIDN'T appear in any earlier trending page.
      // (Earlier trending pages all matched `trendingScore > 0`, so excluding that here
      //  guarantees no row is shown twice across the trending → chrono mode switch.)
      const chronoOnlyWhere: Prisma.PostWhereInput = {
        OR: [{ trendingScore: 0 }, { trendingScore: null }],
      };

      if (fallbackOnly) {
        const fAnd: Prisma.PostWhereInput[] = [...baseAnd, chronoOnlyWhere];
        if (cursorRow) {
          fAnd.push({
            OR: [
              { createdAt: { lt: cursorRow.createdAt } },
              {
                AND: [
                  { createdAt: cursorRow.createdAt },
                  { id: { lt: cursorRow.id } },
                ],
              },
            ],
          });
        }
        const fPosts = await this.prisma.post.findMany({
          where: { AND: fAnd },
          include: feedPostInclude,
          orderBy: [{ createdAt: "desc" }, { id: "desc" }],
          take: takeMain + 1,
        });
        const fSlice = fPosts.slice(0, takeMain);
        const nextCursor =
          fPosts.length > takeMain
            ? (fSlice[fSlice.length - 1]?.id ?? null)
            : null;
        return { posts: fSlice, nextCursor };
      }

      const trendingAnd: Prisma.PostWhereInput[] = [
        ...baseAnd,
        { trendingScore: { gt: 0 } },
      ];
      if (cursorRow && cursorRow.trendingScore != null) {
        const s = cursorRow.trendingScore;
        trendingAnd.push({
          OR: [
            { trendingScore: { lt: s } },
            {
              AND: [
                { trendingScore: s },
                { createdAt: { lt: cursorRow.createdAt } },
              ],
            },
            {
              AND: [
                { trendingScore: s },
                { createdAt: cursorRow.createdAt },
                { id: { lt: cursorRow.id } },
              ],
            },
          ],
        });
      }
      const tPosts = await this.prisma.post.findMany({
        where: { AND: trendingAnd },
        include: feedPostInclude,
        orderBy: [
          { trendingScore: "desc" },
          { createdAt: "desc" },
          { id: "desc" },
        ],
        take: takeMain + 1,
      });

      const haveMoreTrending = tPosts.length > takeMain;
      const tSlice = tPosts.slice(0, takeMain);

      // Trending fully occupies the page → just paginate trending.
      if (haveMoreTrending) {
        const nextCursor = tSlice[tSlice.length - 1]?.id ?? null;
        const out: FeedPost[] =
          pinned && !cursor ? [pinned, ...tSlice] : tSlice;
        return { posts: out, nextCursor };
      }

      // Trending exhausted within this page → supplement with chronological so the page
      // never feels empty just because nothing has been engaged with yet.
      const fillCount = takeMain - tSlice.length;
      let chronoFill: FeedPost[] = [];
      let nextCursor: string | null = null;
      if (fillCount > 0) {
        const cf = await this.prisma.post.findMany({
          where: { AND: [...baseAnd, chronoOnlyWhere] },
          include: feedPostInclude,
          orderBy: [{ createdAt: "desc" }, { id: "desc" }],
          take: fillCount + 1,
        });
        chronoFill = cf.slice(0, fillCount) as FeedPost[];
        if (cf.length > fillCount) {
          nextCursor = chronoFill[chronoFill.length - 1]?.id ?? null;
        }
      }

      const combined: FeedPost[] = [...(tSlice as FeedPost[]), ...chronoFill];
      const out: FeedPost[] =
        pinned && !cursor ? [pinned, ...combined] : combined;
      return { posts: out, nextCursor };
    }

    const cursorWhere = await createdAtIdCursorWhere({
      cursor,
      lookup: async (id) =>
        this.prisma.post.findFirst({
          where: { id, ...groupWhere, ...notDeletedWhere() },
          select: { id: true, createdAt: true },
        }),
    });
    if (cursorWhere) baseAnd.push(cursorWhere);

    const posts = await this.prisma.post.findMany({
      where: { AND: baseAnd },
      include: feedPostInclude,
      orderBy: [{ createdAt: "desc" }, { id: "desc" }],
      take: takeMain + 1,
    });
    const slice = posts.slice(0, takeMain);
    const nextCursor =
      posts.length > takeMain ? (slice[slice.length - 1]?.id ?? null) : null;
    const out: FeedPost[] = pinned && !cursor ? [pinned, ...slice] : slice;
    return { posts: out, nextCursor };
  }

  async collectParentMapForFeed(
    viewerUserId: string | null,
    seedParentIds: Array<string | null | undefined>,
  ): Promise<Map<string, FeedPost>> {
    const ids = await collectAncestorPostIds(this.prisma, seedParentIds);
    if (ids.length === 0) return new Map<string, FeedPost>();

    const rows = await this.getByIds({ viewerUserId, ids });
    return new Map(rows.map((p) => [p.id, p] as const));
  }

  async collectRepostedMapForFeed(
    viewerUserId: string | null,
    repostedPostIds: string[],
  ): Promise<Map<string, FeedPost>> {
    const ids = [
      ...new Set(
        (repostedPostIds ?? []).map((id) => (id ?? "").trim()).filter(Boolean),
      ),
    ];
    if (!ids.length) return new Map<string, FeedPost>();
    const rows = await this.getByIds({ viewerUserId, ids });
    return new Map(rows.map((p) => [p.id, p] as const));
  }

  async communityGroupPreviewMapForFeed(
    viewerUserId: string | null,
    groupIds: string[],
  ): Promise<Map<string, CommunityGroupPreviewDto>> {
    const uniq = [
      ...new Set(
        (groupIds ?? []).map((id) => (id ?? "").trim()).filter(Boolean),
      ),
    ];
    if (uniq.length === 0) return new Map<string, CommunityGroupPreviewDto>();

    // Single batched fetch for all groups + viewer memberships instead of
    // N sequential communityGroupPreviewForGroup calls.
    const [groups, memberships] = await Promise.all([
      this.prisma.communityGroup.findMany({
        where: { id: { in: uniq }, deletedAt: null },
      }),
      viewerUserId
        ? this.prisma.communityGroupMember.findMany({
            where: { groupId: { in: uniq }, userId: viewerUserId },
            select: { groupId: true, status: true, role: true },
          })
        : Promise.resolve([]),
    ]);

    const memberByGroup = new Map(memberships.map((m) => [m.groupId, m]));
    const map = new Map<string, CommunityGroupPreviewDto>();
    for (const g of groups) {
      const membership = memberByGroup.get(g.id) ?? null;
      const dto = toCommunityGroupPreviewDto(g, membership);
      if (dto) map.set(g.id, dto);
    }
    return map;
  }

  async composeFeedPostDtos(params: {
    viewerUserId: string | null;
    filteredPosts: FeedPost[];
    collapsedItemsByItemId: Map<string, FeedCollapsedItem<PostAuthorDto>[]>;
    scoreByPostId?: Map<string, number>;
    includeRestricted?: boolean;
    conversationContext?: boolean;
  }): Promise<PostDto[]> {
    const { viewerUserId, filteredPosts, collapsedItemsByItemId } = params;
    const repostedPostIds = filteredPosts
      .filter(
        (p) =>
          (p as { kind?: string }).kind === "repost" &&
          (p as { repostedPostId?: string }).repostedPostId,
      )
      .map((p) => (p as { repostedPostId: string }).repostedPostId);

    const quotedPostIds = filteredPosts
      .map((p) => (p as { quotedPostId?: string | null }).quotedPostId)
      .filter((id): id is string => Boolean(id));

    const pageIdSet = new Set(filteredPosts.map((p) => p.id));
    const ancestorAndEmbedIds = await collectAncestorPostIds(this.prisma, [
      ...filteredPosts.map((p) => p.parentId),
      ...repostedPostIds,
      ...quotedPostIds,
    ]);
    const fetchIds = ancestorAndEmbedIds.filter((id) => !pageIdSet.has(id));
    const allPostIds = [...pageIdSet, ...ancestorAndEmbedIds];

    const [
      viewer,
      fetchedEmbeds,
      boosted,
      bookmarksByPostId,
      votedPollOptionIdByPostId,
      blockSets,
      repostedByPostId,
      lastSeenAtByPostId,
      commentedByPostId,
    ] = await Promise.all([
      this.enrichment.viewerContext(viewerUserId),
      fetchIds.length
        ? this.getByIds({ viewerUserId, ids: fetchIds })
        : Promise.resolve([] as FeedPost[]),
      viewerUserId
        ? this.enrichment.viewerBoostedPostIds({
            viewerUserId,
            postIds: allPostIds,
          })
        : Promise.resolve(new Set<string>()),
      viewerUserId
        ? this.enrichment.viewerBookmarksByPostId({
            viewerUserId,
            postIds: allPostIds,
          })
        : Promise.resolve(new Map<string, { collectionIds: string[] }>()),
      viewerUserId
        ? this.enrichment.viewerVotedPollOptionIdByPostId({
            viewerUserId,
            postIds: allPostIds,
          })
        : Promise.resolve(new Map<string, string>()),
      viewerUserId
        ? this.enrichment.viewerBlockSets(viewerUserId)
        : Promise.resolve({
            blockedByViewer: new Set<string>(),
            viewerBlockedBy: new Set<string>(),
          }),
      viewerUserId
        ? this.enrichment.viewerRepostedPostIds({
            viewerUserId,
            postIds: allPostIds,
          })
        : Promise.resolve(new Set<string>()),
      viewerUserId
        ? this.enrichment.viewerLastSeenAtByPostId({
            viewerUserId,
            postIds: allPostIds,
          })
        : Promise.resolve(new Map<string, Date>()),
      viewerUserId
        ? this.enrichment.viewerCommentedPostIds({
            viewerUserId,
            postIds: allPostIds,
          })
        : Promise.resolve(new Set<string>()),
    ]);
    const viewedByPostId = new Set(lastSeenAtByPostId.keys());

    const byId = new Map<string, FeedPost>();
    for (const p of filteredPosts) byId.set(p.id, p);
    for (const p of fetchedEmbeds) byId.set(p.id, p);

    const quotedIdSet = new Set(quotedPostIds);
    const repostedIdSet = new Set(repostedPostIds);
    const parentMap = new Map<string, FeedPost>();
    const repostedPostMap = new Map<string, FeedPost>();
    const quotedPostMap = new Map<string, FeedPost>();
    for (const id of ancestorAndEmbedIds) {
      const row = byId.get(id);
      if (!row) continue;
      parentMap.set(id, row);
      if (repostedIdSet.has(id)) repostedPostMap.set(id, row);
      if (quotedIdSet.has(id)) quotedPostMap.set(id, row);
    }

    const viewerHasAdmin = Boolean(viewer?.siteAdmin);
    const [internalByPostId, scoreByPostIdResolved] = viewerHasAdmin
      ? await Promise.all([
          this.ranking.ensureBoostScoresFresh(filteredPosts.map((p) => p.id)),
          params.scoreByPostId
            ? Promise.resolve(params.scoreByPostId)
            : this.ranking.computeScoresForPostIds(allPostIds),
        ])
      : [null, undefined];
    const { blockedByViewer, viewerBlockedBy } = blockSets;

    let viewerCanAccessByPostId: Map<string, boolean> | undefined;
    if (params.includeRestricted && viewer) {
      const allowed = this.enrichment.allowedVisibilitiesForViewer(viewer);
      viewerCanAccessByPostId = new Map(
        [...byId.values()].map((post) => [
          post.id,
          allowed.includes(post.visibility) || post.userId === viewerUserId,
        ]),
      );
    }

    const communityGroupIdsForPage = new Set<string>();
    const accCommunityGroupId = (
      row: { communityGroupId?: string | null } | null | undefined,
    ) => {
      const g = String(row?.communityGroupId ?? "").trim();
      if (g) communityGroupIdsForPage.add(g);
    };
    for (const p of filteredPosts)
      accCommunityGroupId(p as { communityGroupId?: string | null });
    for (const p of parentMap.values())
      accCommunityGroupId(p as { communityGroupId?: string | null });
    for (const p of repostedPostMap.values())
      accCommunityGroupId(p as { communityGroupId?: string | null });
    for (const p of quotedPostMap.values())
      accCommunityGroupId(p as { communityGroupId?: string | null });
    const [groupPreviewByGroupId, videoEmbedByPostId] = await Promise.all([
      this.communityGroupPreviewMapForFeed(viewerUserId, [
        ...communityGroupIdsForPage,
      ]),
      loadPostVideoEmbeds(this.prisma, byId.values()),
    ]);

    const baseUrl = this.appConfig.r2()?.publicBaseUrl ?? null;
    const attachParentChain = buildAttachParentChain({
      parentMap,
      baseUrl,
      boosted,
      bookmarksByPostId,
      votedPollOptionIdByPostId,
      viewerUserId,
      viewerHasAdmin,
      internalByPostId,
      scoreByPostId: scoreByPostIdResolved,
      toPostDto,
      blockedByViewer,
      viewerBlockedBy,
      repostedByPostId,
      commentedByPostId,
      repostedPostMap,
      quotedPostMap,
      groupPreviewByGroupId,
      viewedByPostId,
      lastSeenAtByPostId,
      viewerCanAccessByPostId,
      videoEmbedByPostId,
    });

    const contexts =
      params.conversationContext && viewerUserId && this.conversations
        ? await this.conversations.contexts(
            viewerUserId,
            filteredPosts.map((p) => p.id),
          )
        : new Map();
    // Blocking promises "you won't see their posts": also drop rows that reply to, repost, or
    // quote them. Being blocked by the author still allows read-only viewing.
    return filteredPosts.flatMap((p) => {
      const dto = attachParentChain(p);
      if (postChainInvolvesAuthor(dto, blockedByViewer)) return [];
      if (dto.viewerCanAccess !== false && !dto.deletedAt && contexts.has(p.id))
        dto.conversationContext = contexts.get(p.id);
      applyCollapsedThreadSummary(dto, collapsedItemsByItemId.get(p.id));
      return [dto];
    });
  }

  async listComposedGroupScopedFeed(params: {
    viewerUserId: string;
    groupIds: string[];
    limit: number;
    cursor: string | null;
    sort: "new" | "trending";
    applyPinnedHead: boolean;
    collapseByRoot: boolean;
    collapseMode: "root" | "parent";
    prefer: "reply" | "root";
    collapseMaxPerRoot: number;
    topLevelOnly?: boolean;
  }): Promise<{ data: PostDto[]; pagination: { nextCursor: string | null } }> {
    const viewer = await this.viewerContextService.getViewer(
      params.viewerUserId,
    );
    const allowedVisibilities =
      this.enrichment.allowedVisibilitiesForViewer(viewer);
    const raw = await this.listCommunityGroupsTimelinePosts({
      groupIds: params.groupIds,
      limit: params.limit,
      cursor: params.cursor,
      sort: params.sort,
      applyPinnedHead: params.applyPinnedHead,
      topLevelOnly: params.topLevelOnly,
      allowedVisibilities,
    });
    const groupBaseUrl = this.appConfig.r2()?.publicBaseUrl ?? null;
    // Collapse multi-repost rows before thread-collapse so the thread collapser
    // sees only one row per canonical original.
    const {
      items: groupDedupedPosts,
      repostedByAuthorsByItemId: groupRepostedByAuthors,
      repostedByCountByItemId: groupRepostedByCount,
    } = collapseRepostsByCanonical(raw.posts, (p) =>
      toPostAuthorDtoFromFeedRow(p, groupBaseUrl),
    );
    const { items: filteredPosts, collapsedItemsByItemId } = collapseFeedByRoot(
      groupDedupedPosts,
      {
        collapseByRoot: params.collapseByRoot,
        collapseMode: params.collapseMode,
        prefer: params.prefer,
        maxPerRoot: params.collapseMaxPerRoot,
        getId: (p) => p.id,
        getParentId: (p) => p.parentId ?? null,
        getAuthorPreview: (p) => toPostAuthorDtoFromFeedRow(p, groupBaseUrl),
      },
    );
    const data = await this.composeFeedPostDtos({
      viewerUserId: params.viewerUserId,
      filteredPosts,
      collapsedItemsByItemId,
    });
    for (const dto of data) {
      const authors = groupRepostedByAuthors.get(dto.id);
      const count = groupRepostedByCount.get(dto.id);
      if (authors) dto.repostedByAuthors = authors;
      if (count) dto.repostedByCount = count;
    }
    return { data, pagination: { nextCursor: raw.nextCursor } };
  }

  /** Public-ish group shell for gated permalink + join CTAs (viewer may be null). */
  async communityGroupPreviewForGroup(
    groupId: string,
    viewerUserId: string | null,
  ) {
    const gid = (groupId ?? "").trim();
    if (!gid) return null;
    const g = await this.prisma.communityGroup.findFirst({
      where: { id: gid, deletedAt: null },
    });
    if (!g) return null;
    let viewerMembership: {
      status: "active" | "pending";
      role: "owner" | "moderator" | "member";
    } | null = null;
    if (viewerUserId) {
      const row = await this.prisma.communityGroupMember.findUnique({
        where: { groupId_userId: { groupId: gid, userId: viewerUserId } },
        select: { status: true, role: true },
      });
      viewerMembership = row ?? null;
    }
    return toCommunityGroupPreviewDto(g, viewerMembership);
  }

  /**
   * Integrator-safe lookup: only fully public, published, non-group posts.
   * A single 404 response deliberately hides whether a private/gated row exists.
   */
  async getLatestPublic(): Promise<PostDto> {
    const post = await this.prisma.post.findFirst({
      where: {
        deletedAt: null,
        isDraft: false,
        visibility: "public",
        communityGroupId: null,
      },
      orderBy: { createdAt: "desc" },
      include: feedPostInclude,
    });
    if (!post) throw new NotFoundException("Post not found.");

    const [dto] = await this.composeFeedPostDtos({
      viewerUserId: null,
      filteredPosts: [post],
      collapsedItemsByItemId: new Map(),
    });
    if (!dto) throw new NotFoundException("Post not found.");
    return dto;
  }

  async getPublicById(id: string): Promise<PostDto> {
    const postId = (id ?? "").trim();
    if (!postId) throw new NotFoundException("Post not found.");

    const post = await this.prisma.post.findFirst({
      where: {
        id: postId,
        deletedAt: null,
        isDraft: false,
        visibility: "public",
        communityGroupId: null,
      },
      include: feedPostInclude,
    });
    if (!post) throw new NotFoundException("Post not found.");

    const [dto] = await this.composeFeedPostDtos({
      viewerUserId: null,
      filteredPosts: [post],
      collapsedItemsByItemId: new Map(),
    });
    if (!dto) throw new NotFoundException("Post not found.");
    return dto;
  }

  collectAncestorPostIds(
    seedIds: Array<string | null | undefined>,
  ): Promise<string[]> {
    return collectAncestorPostIds(this.prisma, seedIds);
  }

  /** Cached preview-link video embeds by post id; never fetches externally. */
  videoEmbedsForPosts(posts: Iterable<{ id: string; body?: string | null }>) {
    return loadPostVideoEmbeds(this.prisma, posts);
  }

  /**
   * Batch variant of getById used by feed controllers to reduce per-id round trips.
   * Applies the same visibility rules as getById and omits inaccessible/missing ids.
   */
  async getByIds(params: {
    viewerUserId: string | null;
    ids: string[];
  }): Promise<FeedPost[]> {
    const viewerUserId = params.viewerUserId ?? null;
    const ids = [
      ...new Set(
        (params.ids ?? []).map((id) => (id ?? "").trim()).filter(Boolean),
      ),
    ];
    if (!ids.length) return [];

    const viewer = await this.viewerContextService.getViewer(viewerUserId);
    const allowed = this.enrichment.allowedVisibilitiesForViewer(viewer);

    const cached: FeedPost[] = [];
    const missingIds: string[] = [];
    for (const id of ids) {
      const cacheKey = `posts.getById:${viewerUserId ?? "anon"}:${id}`;
      const cachedPost = this.requestCache.get<FeedPost>(cacheKey);
      if (cachedPost) {
        cached.push(cachedPost);
      } else {
        missingIds.push(id);
      }
    }

    const fetched = missingIds.length
      ? await this.prisma.post.findMany({
          where: { id: { in: missingIds } },
          include: feedPostInclude,
        })
      : [];

    const groupIdsForVis = [
      ...new Set(
        fetched
          .map(
            (p) => (p as { communityGroupId?: string | null }).communityGroupId,
          )
          .filter((x): x is string => Boolean(x)),
      ),
    ];
    let memberGroupIdsForVis = new Set<string>();
    if (viewerUserId && groupIdsForVis.length > 0) {
      const memRows = await this.prisma.communityGroupMember.findMany({
        where: {
          userId: viewerUserId,
          groupId: { in: groupIdsForVis },
          status: "active",
        },
        select: { groupId: true },
      });
      memberGroupIdsForVis = new Set(memRows.map((r) => r.groupId));
    }

    const visibleFetched = fetched.filter((post) => {
      const isSelf = Boolean(viewer && viewer.id === post.userId);
      if (isSelf) return true;
      if (post.visibility === "onlyMe") return Boolean(viewer?.siteAdmin);
      const pg =
        (post as { communityGroupId?: string | null }).communityGroupId ?? null;
      if (pg && memberGroupIdsForVis.has(pg)) return true;
      return allowed.includes(post.visibility);
    });

    const visibleFetchedGroupScoped =
      await this.access.filterPostsByCommunityGroupAccess({
        viewerUserId,
        viewer,
        posts: visibleFetched,
      });

    for (const post of visibleFetchedGroupScoped) {
      const cacheKey = `posts.getById:${viewerUserId ?? "anon"}:${post.id}`;
      this.requestCache.set(cacheKey, post as FeedPost);
    }

    const byId = new Map<string, FeedPost>([
      ...cached.map((p) => [p.id, p] as const),
      ...visibleFetchedGroupScoped.map((p) => [p.id, p as FeedPost] as const),
    ]);
    return ids
      .map((id) => byId.get(id))
      .filter((p): p is FeedPost => Boolean(p));
  }
}
