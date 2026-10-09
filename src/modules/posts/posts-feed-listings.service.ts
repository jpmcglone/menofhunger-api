import { PostsFeedComposeService } from "./posts-feed-compose.service";
import { ForbiddenException, Injectable, NotFoundException } from "@nestjs/common";
import { Prisma } from "@prisma/client";
import type { PostVisibility } from "@prisma/client";
import { PrismaService } from "../prisma/prisma.service";
import { RequestCacheService } from "../../common/cache/request-cache.service";
import { ViewerContextService } from "../viewer/viewer-context.service";
import { AppConfigService } from "../app/app-config.service";
import { buildPostVisibilityWhere } from "../../common/posts/post-visibility";
import { createdAtIdCursorWhere, createdAtIdBefore } from "../../common/pagination/created-at-id-cursor";
import { toCommunityGroupPreviewDto } from "../../common/dto/community-group.dto";
import { collapseFeedByRoot } from "../../common/feed-collapse/collapse-by-root";
import { collapseRepostsByCanonical } from "../../common/feed-collapse/collapse-reposts-by-canonical";
import { toPostAuthorDtoFromFeedRow, type PostDto } from "../../common/dto/post.dto";
import { excludeCommunityGroupPostsWhere, mediaOnlyWhere, notDeletedWhere, userNotBannedWhere } from "./posts-query-builders";
import { feedPostInclude, mediaFeedPostInclude, type FeedPost, type FeedResult } from "./posts-feed.types";
import { PostsViewerEnrichmentService } from "./posts-viewer-enrichment.service";
import { PostsRankingService } from "./posts-ranking.service";
import { CommunityGroupReadAccessService } from "../viewer/community-group-read-access.service";
import { PostsFeedAccessService } from "./posts-feed-access.service";
import { findGroupMember, listActiveGroupIdsForUser } from '../viewer/group-membership.queries';
import { toPage } from '../../common/pagination/page';
import { NOT_DELETED } from '../../common/prisma/where';

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
    private readonly compose: PostsFeedComposeService,
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

    const { items: slice, nextCursor } = toPage(posts, limit, (r) => r.id);
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

    const { items: slice, nextCursor } = toPage(posts, limit, (r) => r.id);

    return { posts: slice, nextCursor };
  }

  async listActiveCommunityGroupIdsForUser(
    viewerUserId: string,
  ): Promise<string[]> {
    return listActiveGroupIdsForUser(this.prisma, viewerUserId);
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
          fAnd.push(createdAtIdBefore({ createdAt: cursorRow.createdAt, id: cursorRow.id }));
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
    const { items: slice, nextCursor } = toPage(posts, takeMain, (r) => r.id);
    const out: FeedPost[] = pinned && !cursor ? [pinned, ...slice] : slice;
    return { posts: out, nextCursor };
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
    const data = await this.compose.composeFeedPostDtos({
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
      where: { id: gid, ...NOT_DELETED },
    });
    if (!g) return null;
    let viewerMembership: {
      status: "active" | "pending";
      role: "owner" | "moderator" | "member";
    } | null = null;
    if (viewerUserId) {
      const row = await findGroupMember(this.prisma, gid, viewerUserId);
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
        ...NOT_DELETED,
        isDraft: false,
        visibility: "public",
        communityGroupId: null,
      },
      orderBy: { createdAt: "desc" },
      include: feedPostInclude,
    });
    if (!post) throw new NotFoundException("Post not found.");

    const [dto] = await this.compose.composeFeedPostDtos({
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
        ...NOT_DELETED,
        isDraft: false,
        visibility: "public",
        communityGroupId: null,
      },
      include: feedPostInclude,
    });
    if (!post) throw new NotFoundException("Post not found.");

    const [dto] = await this.compose.composeFeedPostDtos({
      viewerUserId: null,
      filteredPosts: [post],
      collapsedItemsByItemId: new Map(),
    });
    if (!dto) throw new NotFoundException("Post not found.");
    return dto;
  }

}
