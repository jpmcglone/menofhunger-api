import { ForbiddenException, Injectable, NotFoundException } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import type { CommunityGroupJoinPolicy, PostMediaKind, PostVisibility } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { RequestCacheService } from '../../common/cache/request-cache.service';
import { ViewerContextService, type ViewerContext } from '../viewer/viewer-context.service';
import { AppConfigService } from '../app/app-config.service';
import { createdAtIdCursorWhere } from '../../common/pagination/created-at-id-cursor';
import { toCommunityGroupPreviewDto } from '../../common/dto/community-group.dto';
import type { CommunityGroupPreviewDto } from '../../common/dto/community-group.dto';
import { ARTICLE_SHARE_INCLUDE, QUOTED_POST_INCLUDE } from '../../common/prisma-includes/post.include';
import { MENTION_USER_SELECT, USER_LIST_SELECT } from '../../common/prisma-selects/user.select';
import { collapseFeedByRoot } from '../../common/feed-collapse/collapse-by-root';
import { toPostDto, type PostDto } from '../../common/dto/post.dto';
import { buildAttachParentChain } from './posts.utils';
import { POSTS_RANKING } from './posts-ranking.config';
import {
  excludeCommunityGroupPostsWhere,
  mediaOnlyWhere,
  notDeletedWhere,
  userNotBannedWhere,
} from './posts-query-builders';
import { feedPostInclude, mediaFeedPostInclude, type FeedPost, type FeedResult, type PopularFeedResult, type PostCounts } from './posts-feed.types';
import { PostsRankingService } from './posts-ranking.service';
import { PostsViewerEnrichmentService } from './posts-viewer-enrichment.service';
import { CommunityGroupReadAccessService } from '../viewer/community-group-read-access.service';

/**
 * Post read paths: feeds (chrono, popular, featured, for-you), profile and
 * group listings, comments/threads, single-post lookups, media grids, and the
 * DTO composition helpers that decorate raw rows with viewer overlays.
 */
@Injectable()
export class PostsFeedQueryService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly requestCache: RequestCacheService,
    private readonly viewerContextService: ViewerContextService,
    private readonly appConfig: AppConfigService,
    private readonly enrichment: PostsViewerEnrichmentService,
    private readonly ranking: PostsRankingService,
    private readonly groupReadAccess: CommunityGroupReadAccessService,
  ) {}

  /**
   * Group post read access:
   *   • OPEN groups: any signed-in, verified user can read posts.
   *   • PRIVATE (approval) groups: members-only.
   * Posting still requires active membership regardless of joinPolicy — that
   * gate lives on the create path, not here.
   */
  private async assertReadableCommunityGroupPost(
    post: { userId: string; communityGroupId: string | null },
    viewerUserId: string | null,
    viewer: ViewerContext | null,
    opts?: { knownActiveMember?: boolean; knownGroupJoinPolicy?: CommunityGroupJoinPolicy },
  ): Promise<void> {
    const gid = post.communityGroupId;
    if (!gid) return;
    if (viewer?.siteAdmin) return;
    if (viewerUserId && post.userId === viewerUserId) return;
    if (!viewerUserId) throw new ForbiddenException('Sign in to view this post.');
    if (opts?.knownActiveMember) return;

    let joinPolicy: CommunityGroupJoinPolicy | null = opts?.knownGroupJoinPolicy ?? null;
    if (!joinPolicy) {
      const g = await this.prisma.communityGroup.findUnique({
        where: { id: gid },
        select: { joinPolicy: true },
      });
      joinPolicy = g?.joinPolicy ?? 'approval';
    }

    if (joinPolicy === 'open') {
      if (this.viewerContextService.isVerified(viewer)) return;
      throw new ForbiddenException('Verify your account to view group posts.');
    }

    const m = await this.prisma.communityGroupMember.findUnique({
      where: { groupId_userId: { groupId: gid, userId: viewerUserId } },
      select: { status: true },
    });
    if (!m || m.status !== 'active') {
      throw new ForbiddenException('This post is only visible to group members.');
    }
  }

  private async filterPostsByCommunityGroupAccess(params: {
    viewerUserId: string | null;
    viewer: ViewerContext | null;
    posts: FeedPost[];
  }): Promise<FeedPost[]> {
    const { viewerUserId, viewer, posts } = params;
    const groupIds = [
      ...new Set(
        posts
          .map((p) => (p as { communityGroupId?: string | null }).communityGroupId)
          .filter((x): x is string => Boolean(x)),
      ),
    ];
    if (groupIds.length === 0) return posts;

    // Fetch joinPolicy for each referenced group so OPEN groups can pass through
    // for verified non-members (posts in OPEN groups are readable by any
    // verified user; PRIVATE/approval groups remain members-only).
    const groups = await this.prisma.communityGroup.findMany({
      where: { id: { in: groupIds } },
      select: { id: true, joinPolicy: true },
    });
    const policyByGroup = new Map(groups.map((g) => [g.id, g.joinPolicy] as const));

    let memberGroupIds = new Set<string>();
    if (viewerUserId) {
      const rows = await this.prisma.communityGroupMember.findMany({
        where: { userId: viewerUserId, groupId: { in: groupIds }, status: 'active' },
        select: { groupId: true },
      });
      memberGroupIds = new Set(rows.map((r) => r.groupId));
    }

    const viewerVerified = this.viewerContextService.isVerified(viewer);

    return posts.filter((p) => {
      const gid = (p as { communityGroupId?: string | null }).communityGroupId ?? null;
      if (!gid) return true;
      if (viewer?.siteAdmin) return true;
      if (viewerUserId && p.userId === viewerUserId) return true;
      if (memberGroupIds.has(gid)) return true;
      if (viewerVerified && policyByGroup.get(gid) === 'open') return true;
      return false;
    });
  }

  private encodePopularCursor(cursor: { score: number; createdAt: string; id: string }) {
    return Buffer.from(JSON.stringify(cursor), 'utf8').toString('base64url');
  }

  private decodePopularCursor(token: string | null): { score: number; createdAt: string; id: string } | null {
    const t = (token ?? '').trim();
    if (!t) return null;
    try {
      const raw = Buffer.from(t, 'base64url').toString('utf8');
      // Accept both old cursors (with asOf field) and new cursors (without).
      const parsed = JSON.parse(raw) as Partial<{ asOf: string; score: number; createdAt: string; id: string }>;
      const createdAt = typeof parsed.createdAt === 'string' ? parsed.createdAt : '';
      const id = typeof parsed.id === 'string' ? parsed.id : '';
      const score = typeof parsed.score === 'number' && Number.isFinite(parsed.score) ? parsed.score : NaN;
      if (!createdAt || !id) return null;
      if (!Number.isFinite(score)) return null;
      return { score, createdAt, id };
    } catch {
      return null;
    }
  }

  private encodeForYouCursor(servedIds: string[]) {
    const ids = [...new Set((servedIds ?? []).map((id) => (id ?? '').trim()).filter(Boolean))]
      .slice(-POSTS_RANKING.forYouCursorServedIdMax);
    if (ids.length === 0) return null;
    return Buffer.from(JSON.stringify({ v: 2, s: ids }), 'utf8').toString('base64url');
  }

  private decodeForYouCursor(token: string | null): { servedIds: string[]; legacyPopular: { score: number; createdAt: string; id: string } | null } {
    const t = (token ?? '').trim();
    if (!t) return { servedIds: [], legacyPopular: null };
    try {
      const raw = Buffer.from(t, 'base64url').toString('utf8');
      const parsed = JSON.parse(raw) as Partial<{ v: number; s: unknown }>;
      if (parsed.v === 2 && Array.isArray(parsed.s)) {
        return {
          servedIds: parsed.s
            .map((id) => (typeof id === 'string' ? id.trim() : ''))
            .filter(Boolean)
            .slice(-POSTS_RANKING.forYouCursorServedIdMax),
          legacyPopular: null,
        };
      }
    } catch {
      // Fall through to legacy cursor handling below.
    }
    return { servedIds: [], legacyPopular: this.decodePopularCursor(token) };
  }

  async listOnlyMe(params: { userId: string; limit: number; cursor: string | null }) {
    const { userId, limit, cursor } = params;

    const cursorWhere = await createdAtIdCursorWhere({
      cursor,
      lookup: async (id) => await this.prisma.post.findUnique({ where: { id }, select: { id: true, createdAt: true } }),
    });

    const posts = await this.prisma.post.findMany({
      where: {
        AND: [
          { userId, visibility: 'onlyMe', parentId: null, isDraft: false, ...notDeletedWhere() },
          ...(cursorWhere ? [cursorWhere] : []),
        ],
      },
      include: feedPostInclude,
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      take: limit + 1,
    });

    const slice = posts.slice(0, limit);
    const nextCursor = posts.length > limit ? slice[slice.length - 1]?.id ?? null : null;
    return { posts: slice, nextCursor };
  }

  async listFeed(params: {
    viewerUserId: string | null;
    limit: number;
    cursor: string | null;
    visibility: 'all' | PostVisibility;
    followingOnly: boolean;
    kind?: 'regular' | 'checkin' | null;
    checkinDayKey?: string | null;
    /** When true, include the viewer's own posts (overrides home-feed self-exclusion). */
    includeSelf?: boolean;
    mediaOnly?: boolean;
    topLevelOnly?: boolean;
    authorUserIds?: string[] | null;
  }): Promise<FeedResult> {
    const { viewerUserId, limit, cursor, visibility, followingOnly } = params;
    const authorUserIds = (params.authorUserIds ?? null)?.map((s) => (s ?? '').trim()).filter(Boolean) ?? null;
    const kind = (params.kind ?? null) as 'regular' | 'checkin' | null;
    const checkinDayKey = (params.checkinDayKey ?? null)?.trim() || null;

    const viewer = await this.viewerContextService.getViewer(viewerUserId);

    const allowed = this.enrichment.allowedVisibilitiesForViewer(viewer);

    if (visibility === 'verifiedOnly') {
      if (!viewer || viewer.verifiedStatus === 'none') throw new ForbiddenException('Verify to view verified-only posts.');
    }
    if (visibility === 'premiumOnly') {
      if (!viewer || !this.viewerContextService.isPremium(viewer)) {
        throw new ForbiddenException('Upgrade to premium to view premium-only posts.');
      }
    }

    if (followingOnly && !viewerUserId) {
      return { posts: [], nextCursor: null };
    }

    // Author always sees own posts (e.g. after tier downgrade); others filtered by allowed visibility.
    const baseVisibility =
      visibility === 'all'
        ? ({ visibility: { in: allowed } } as Prisma.PostWhereInput)
        : visibility === 'public'
          ? ({ visibility: 'public' } as Prisma.PostWhereInput)
          : ({ visibility } as Prisma.PostWhereInput);
    
    // IMPORTANT: Only apply "author sees own posts" override when visibility='all'.
    // When user explicitly filters by a specific visibility, respect that filter even for their own posts.
    const visibilityWhere =
      viewerUserId && visibility === 'all'
        ? ({
            OR: [
              baseVisibility,
              // Author sees own posts (e.g. after tier downgrade), but never include only-me outside /only-me.
              { userId: viewerUserId, visibility: { not: 'onlyMe' } },
            ],
          } as Prisma.PostWhereInput)
        : baseVisibility;

    if (authorUserIds && authorUserIds.length === 0) {
      return { posts: [], nextCursor: null };
    }

    // Group posts are excluded from all home feeds; they appear only on the group wall
    // and permalink (/p/:id). The Groups badge is the primary signal for new group activity.
    const communityScopeWhere: Prisma.PostWhereInput = excludeCommunityGroupPostsWhere();

    // Exclude the viewer's own posts from home feeds (Following + All) unless the feed
    // is explicitly scoped to a set of author IDs (e.g. profile view, crew feed),
    // or the caller explicitly opts in with includeSelf (e.g. per-day check-in feeds).
    const excludeSelfWhere: Prisma.PostWhereInput[] =
      viewerUserId && !authorUserIds?.length && !params.includeSelf
        ? ([{ NOT: { userId: viewerUserId } }] as Prisma.PostWhereInput[])
        : [];

    const where = followingOnly
      ? {
          AND: [
            visibilityWhere,
            notDeletedWhere(),
            communityScopeWhere,
            userNotBannedWhere(),
            ...(kind ? ([{ kind }] as Prisma.PostWhereInput[]) : []),
            ...(checkinDayKey ? ([{ checkinDayKey }] as Prisma.PostWhereInput[]) : []),
            ...(params.mediaOnly ? [mediaOnlyWhere()] : []),
            ...(params.topLevelOnly ? ([{ parentId: null }] as Prisma.PostWhereInput[]) : []),
            ...(authorUserIds?.length ? ([{ userId: { in: authorUserIds } }] as Prisma.PostWhereInput[]) : []),
            ...excludeSelfWhere,
            { user: { followers: { some: { followerId: viewerUserId as string } } } },
          ],
        }
      : {
          AND: [
            visibilityWhere,
            notDeletedWhere(),
            communityScopeWhere,
            userNotBannedWhere(),
            ...(kind ? ([{ kind }] as Prisma.PostWhereInput[]) : []),
            ...(checkinDayKey ? ([{ checkinDayKey }] as Prisma.PostWhereInput[]) : []),
            ...(params.mediaOnly ? [mediaOnlyWhere()] : []),
            ...(params.topLevelOnly ? ([{ parentId: null }] as Prisma.PostWhereInput[]) : []),
            ...(authorUserIds?.length ? ([{ userId: { in: authorUserIds } }] as Prisma.PostWhereInput[]) : []),
            ...excludeSelfWhere,
          ],
        };

    const cursorWhere = await createdAtIdCursorWhere({
      cursor,
      lookup: async (id) => await this.prisma.post.findUnique({ where: { id }, select: { id: true, createdAt: true } }),
    });
    const whereWithCursor = cursorWhere ? ({ AND: [where, cursorWhere] } as Prisma.PostWhereInput) : where;
    const include = params.mediaOnly ? mediaFeedPostInclude : feedPostInclude;

    const posts = (await this.prisma.post.findMany({
      where: whereWithCursor,
      include,
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      take: limit + 1,
    })) as FeedPost[];

    const slice = posts.slice(0, limit);
    const nextCursor = posts.length > limit ? slice[slice.length - 1]?.id ?? null : null;

    return { posts: slice, nextCursor };
  }

  async listActiveCommunityGroupIdsForUser(viewerUserId: string): Promise<string[]> {
    const rows = await this.prisma.communityGroupMember.findMany({
      where: { userId: viewerUserId, status: 'active' },
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
  async assertCanReadCommunityGroup(viewerUserId: string | null, groupId: string): Promise<void> {
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
    sort: 'new' | 'trending';
    applyPinnedHead: boolean;
    topLevelOnly?: boolean;
    allowedVisibilities: PostVisibility[];
  }): Promise<FeedResult> {
    const { groupIds, limit, cursor, sort } = params;
    if (groupIds.length === 0) return { posts: [], nextCursor: null };

    const groupWhere: Prisma.PostWhereInput =
      groupIds.length === 1 ? { communityGroupId: groupIds[0]! } : { communityGroupId: { in: groupIds } };

    const topLevelFilter: Prisma.PostWhereInput = params.topLevelOnly ? { parentId: null } : {};

    const applyPin =
      Boolean(params.applyPinnedHead && sort === 'new' && !cursor && groupIds.length === 1) && groupIds[0];

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
        orderBy: { pinnedInGroupAt: 'desc' },
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

    if (sort === 'trending') {
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
      const fallbackOnly = Boolean(cursor) && (!cursorRow || cursorRow.trendingScore == null);

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
              { AND: [{ createdAt: cursorRow.createdAt }, { id: { lt: cursorRow.id } }] },
            ],
          });
        }
        const fPosts = await this.prisma.post.findMany({
          where: { AND: fAnd },
          include: feedPostInclude,
          orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
          take: takeMain + 1,
        });
        const fSlice = fPosts.slice(0, takeMain);
        const nextCursor = fPosts.length > takeMain ? fSlice[fSlice.length - 1]?.id ?? null : null;
        return { posts: fSlice, nextCursor };
      }

      const trendingAnd: Prisma.PostWhereInput[] = [...baseAnd, { trendingScore: { gt: 0 } }];
      if (cursorRow && cursorRow.trendingScore != null) {
        const s = cursorRow.trendingScore;
        trendingAnd.push({
          OR: [
            { trendingScore: { lt: s } },
            { AND: [{ trendingScore: s }, { createdAt: { lt: cursorRow.createdAt } }] },
            { AND: [{ trendingScore: s }, { createdAt: cursorRow.createdAt }, { id: { lt: cursorRow.id } }] },
          ],
        });
      }
      const tPosts = await this.prisma.post.findMany({
        where: { AND: trendingAnd },
        include: feedPostInclude,
        orderBy: [{ trendingScore: 'desc' }, { createdAt: 'desc' }, { id: 'desc' }],
        take: takeMain + 1,
      });

      const haveMoreTrending = tPosts.length > takeMain;
      const tSlice = tPosts.slice(0, takeMain);

      // Trending fully occupies the page → just paginate trending.
      if (haveMoreTrending) {
        const nextCursor = tSlice[tSlice.length - 1]?.id ?? null;
        const out: FeedPost[] = pinned && !cursor ? [pinned, ...tSlice] : tSlice;
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
          orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
          take: fillCount + 1,
        });
        chronoFill = cf.slice(0, fillCount) as FeedPost[];
        if (cf.length > fillCount) {
          nextCursor = chronoFill[chronoFill.length - 1]?.id ?? null;
        }
      }

      const combined: FeedPost[] = [...(tSlice as FeedPost[]), ...chronoFill];
      const out: FeedPost[] = pinned && !cursor ? [pinned, ...combined] : combined;
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
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      take: takeMain + 1,
    });
    const slice = posts.slice(0, takeMain);
    const nextCursor = posts.length > takeMain ? slice[slice.length - 1]?.id ?? null : null;
    const out: FeedPost[] = pinned && !cursor ? [pinned, ...slice] : slice;
    return { posts: out, nextCursor };
  }

  async collectParentMapForFeed(
    viewerUserId: string | null,
    seedParentIds: Array<string | null | undefined>,
  ): Promise<Map<string, FeedPost>> {
    const seeds = [...new Set((seedParentIds ?? []).filter((id): id is string => Boolean(id)))];
    if (seeds.length === 0) return new Map<string, FeedPost>();

    // Single recursive CTE to walk the full ancestor chain in one DB round trip,
    // instead of the previous while-loop that did N sequential queries (one per depth level).
    // Depth is capped at 20 to prevent runaway recursion on circular references.
    const allIds: Array<{ id: string }> = await this.prisma.$queryRawUnsafe(`
      WITH RECURSIVE ancestors AS (
        SELECT id, "parentId" FROM "Post" WHERE id = ANY($1) AND "deletedAt" IS NULL
        UNION
        SELECT p.id, p."parentId" FROM "Post" p
        INNER JOIN ancestors a ON a."parentId" = p.id
        WHERE p."deletedAt" IS NULL
      )
      SELECT DISTINCT id FROM ancestors
    `, seeds);

    const ids = allIds.map((r) => r.id);
    if (ids.length === 0) return new Map<string, FeedPost>();

    // Single batched Prisma call for all ancestors with full includes.
    const rows = await this.getByIds({ viewerUserId, ids });
    return new Map(rows.map((p) => [p.id, p] as const));
  }

  async collectRepostedMapForFeed(viewerUserId: string | null, repostedPostIds: string[]): Promise<Map<string, FeedPost>> {
    const ids = [...new Set((repostedPostIds ?? []).map((id) => (id ?? '').trim()).filter(Boolean))];
    if (!ids.length) return new Map<string, FeedPost>();
    const rows = await this.getByIds({ viewerUserId, ids });
    return new Map(rows.map((p) => [p.id, p] as const));
  }

  async communityGroupPreviewMapForFeed(
    viewerUserId: string | null,
    groupIds: string[],
  ): Promise<Map<string, CommunityGroupPreviewDto>> {
    const uniq = [...new Set((groupIds ?? []).map((id) => (id ?? '').trim()).filter(Boolean))];
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
    collapsedCountByItemId: Map<string, number>;
    scoreByPostId?: Map<string, number>;
  }): Promise<PostDto[]> {
    const { viewerUserId, filteredPosts, collapsedCountByItemId } = params;
    const repostedPostIds = filteredPosts
      .filter((p) => (p as { kind?: string }).kind === 'repost' && (p as { repostedPostId?: string }).repostedPostId)
      .map((p) => (p as { repostedPostId: string }).repostedPostId);

    const [viewer, parentMap, repostedPostMap] = await Promise.all([
      this.enrichment.viewerContext(viewerUserId),
      this.collectParentMapForFeed(
        viewerUserId,
        filteredPosts.map((p) => p.parentId),
      ),
      this.collectRepostedMapForFeed(viewerUserId, repostedPostIds),
    ]);
    const viewerHasAdmin = Boolean(viewer?.siteAdmin);
    const allPostIds = [...filteredPosts.map((p) => p.id), ...parentMap.keys()];

    const [
      boosted,
      bookmarksByPostId,
      votedPollOptionIdByPostId,
      blockSets,
      repostedByPostId,
      internalByPostId,
      scoreByPostIdResolved,
    ] = await Promise.all([
      viewerUserId
        ? this.enrichment.viewerBoostedPostIds({ viewerUserId, postIds: allPostIds })
        : Promise.resolve(new Set<string>()),
      viewerUserId
        ? this.enrichment.viewerBookmarksByPostId({ viewerUserId, postIds: allPostIds })
        : Promise.resolve(new Map<string, { collectionIds: string[] }>()),
      viewerUserId
        ? this.enrichment.viewerVotedPollOptionIdByPostId({ viewerUserId, postIds: allPostIds })
        : Promise.resolve(new Map<string, string>()),
      viewerUserId
        ? this.enrichment.viewerBlockSets(viewerUserId)
        : Promise.resolve({ blockedByViewer: new Set<string>(), viewerBlockedBy: new Set<string>() }),
      viewerUserId
        ? this.enrichment.viewerRepostedPostIds({ viewerUserId, postIds: allPostIds })
        : Promise.resolve(new Set<string>()),
      viewerHasAdmin ? this.ranking.ensureBoostScoresFresh(filteredPosts.map((p) => p.id)) : Promise.resolve(null),
      viewerHasAdmin
        ? params.scoreByPostId
          ? Promise.resolve(params.scoreByPostId)
          : this.ranking.computeScoresForPostIds(allPostIds)
        : Promise.resolve(undefined),
    ]);
    const { blockedByViewer, viewerBlockedBy } = blockSets;

    const communityGroupIdsForPage = new Set<string>();
    const accCommunityGroupId = (row: { communityGroupId?: string | null } | null | undefined) => {
      const g = String(row?.communityGroupId ?? '').trim();
      if (g) communityGroupIdsForPage.add(g);
    };
    for (const p of filteredPosts) accCommunityGroupId(p as { communityGroupId?: string | null });
    for (const p of parentMap.values()) accCommunityGroupId(p as { communityGroupId?: string | null });
    for (const p of repostedPostMap.values()) accCommunityGroupId(p as { communityGroupId?: string | null });
    const groupPreviewByGroupId = await this.communityGroupPreviewMapForFeed(viewerUserId, [
      ...communityGroupIdsForPage,
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
      repostedPostMap,
      groupPreviewByGroupId,
    });

    return filteredPosts.map((p) => {
      const dto = attachParentChain(p);
      const collapsed = collapsedCountByItemId.get(p.id);
      if (collapsed && collapsed > 0) (dto as { threadCollapsedCount?: number }).threadCollapsedCount = collapsed;
      return dto;
    });
  }

  async listComposedGroupScopedFeed(params: {
    viewerUserId: string;
    groupIds: string[];
    limit: number;
    cursor: string | null;
    sort: 'new' | 'trending';
    applyPinnedHead: boolean;
    collapseByRoot: boolean;
    collapseMode: 'root' | 'parent';
    prefer: 'reply' | 'root';
    collapseMaxPerRoot: number;
    topLevelOnly?: boolean;
  }): Promise<{ data: PostDto[]; pagination: { nextCursor: string | null } }> {
    const viewer = await this.viewerContextService.getViewer(params.viewerUserId);
    const allowedVisibilities = this.enrichment.allowedVisibilitiesForViewer(viewer);
    const raw = await this.listCommunityGroupsTimelinePosts({
      groupIds: params.groupIds,
      limit: params.limit,
      cursor: params.cursor,
      sort: params.sort,
      applyPinnedHead: params.applyPinnedHead,
      topLevelOnly: params.topLevelOnly,
      allowedVisibilities,
    });
    const { items: filteredPosts, collapsedCountByItemId } = collapseFeedByRoot(raw.posts, {
      collapseByRoot: params.collapseByRoot,
      collapseMode: params.collapseMode,
      prefer: params.prefer,
      maxPerRoot: params.collapseMaxPerRoot,
      getId: (p) => p.id,
      getParentId: (p) => p.parentId ?? null,
    });
    const data = await this.composeFeedPostDtos({
      viewerUserId: params.viewerUserId,
      filteredPosts,
      collapsedCountByItemId,
    });
    return { data, pagination: { nextCursor: raw.nextCursor } };
  }

  /** Public-ish group shell for gated permalink + join CTAs (viewer may be null). */
  async communityGroupPreviewForGroup(groupId: string, viewerUserId: string | null) {
    const gid = (groupId ?? '').trim();
    if (!gid) return null;
    const g = await this.prisma.communityGroup.findFirst({
      where: { id: gid, deletedAt: null },
    });
    if (!g) return null;
    let viewerMembership: { status: 'active' | 'pending'; role: 'owner' | 'moderator' | 'member' } | null =
      null;
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
   * Returns userIds the viewer follows for "following" feed scope.
   * The viewer is intentionally excluded so their own posts do not appear in
   * the home Following/All feeds (only other people's posts are returned).
   * Used by trending (popular) feed when followingOnly is true.
   */
  private async getAuthorIdsForFollowingFilter(viewerUserId: string): Promise<string[]> {
    const follows = await this.prisma.follow.findMany({
      where: { followerId: viewerUserId },
      select: { followingId: true },
    });
    return follows.map((f) => f.followingId);
  }

  /** Trending feed: reads directly from Post.trendingScore (set by the popular-score cron). */
  private async listPopularFeedFromScore(params: {
    viewerUserId: string | null;
    limit: number;
    decodedCursor: { score: number; createdAt: string; id: string } | null;
    visibility: 'all' | PostVisibility;
    allowed: PostVisibility[];
    authorUserIds: string[] | null;
    kind: 'regular' | 'checkin' | null;
    mediaOnly?: boolean;
    topLevelOnly?: boolean;
    memberGroupIds?: string[];
    excludeAuthorUserId?: string | null;
  }): Promise<PopularFeedResult> {
    const { viewerUserId, limit, decodedCursor, visibility, allowed, authorUserIds, kind } = params;
    const memberGroupIds = params.memberGroupIds ?? [];

    const baseVisibilityWhere: Prisma.PostWhereInput =
      visibility === 'all'
        ? { visibility: { in: allowed } }
        : visibility === 'public'
          ? { visibility: 'public' }
          : { visibility };

    // IMPORTANT: Only apply "author sees own posts" override when visibility='all'.
    const visibilityWhere: Prisma.PostWhereInput =
      viewerUserId && visibility === 'all'
        ? { OR: [baseVisibilityWhere, { userId: viewerUserId, visibility: { not: 'onlyMe' } }] }
        : baseVisibilityWhere;

    const cursorScore = decodedCursor?.score ?? null;
    const cursorCreatedAt = decodedCursor ? new Date(decodedCursor.createdAt) : null;
    const cursorId = decodedCursor?.id ?? null;

    const cursorWhere: Prisma.PostWhereInput =
      decodedCursor && cursorScore != null && cursorCreatedAt && cursorId
        ? {
            OR: [
              { trendingScore: { lt: cursorScore } } as Prisma.PostWhereInput,
              {
                AND: [
                  { trendingScore: cursorScore } as Prisma.PostWhereInput,
                  {
                    OR: [
                      { createdAt: { lt: cursorCreatedAt } },
                      { AND: [{ createdAt: cursorCreatedAt }, { id: { lt: cursorId } }] },
                    ],
                  },
                ],
              },
            ],
          }
        : {};
    const communityScopeWhere: Prisma.PostWhereInput =
      memberGroupIds.length > 0
        ? { OR: [excludeCommunityGroupPostsWhere(), { communityGroupId: { in: memberGroupIds } }] }
        : excludeCommunityGroupPostsWhere();

    const posts = await this.prisma.post.findMany({
      where: {
        AND: [
          { deletedAt: null },
          params.mediaOnly
            ? { OR: [{ trendingScore: { gte: 0 } }, { trendingScore: null }] }
            : { trendingScore: { gt: 0 } },
          { kind: { not: 'repost' } },
          { user: { bannedAt: null } },
          communityScopeWhere,
          ...(kind ? ([{ kind }] as Prisma.PostWhereInput[]) : []),
          ...(authorUserIds?.length ? ([{ userId: { in: authorUserIds } }] as Prisma.PostWhereInput[]) : []),
          ...(params.excludeAuthorUserId ? ([{ NOT: { userId: params.excludeAuthorUserId } }] as Prisma.PostWhereInput[]) : []),
          ...(params.mediaOnly ? [mediaOnlyWhere()] : []),
          ...(params.topLevelOnly ? ([{ parentId: null }] as Prisma.PostWhereInput[]) : []),
          visibilityWhere,
          cursorWhere,
        ],
      },
      orderBy: [{ trendingScore: 'desc' }, { createdAt: 'desc' }, { id: 'desc' }],
      take: limit + 1,
      include: params.mediaOnly ? mediaFeedPostInclude : feedPostInclude,
    }) as FeedPost[];

    const slicePosts = posts.slice(0, limit);
    const nextPost = posts.length > limit ? slicePosts[slicePosts.length - 1] ?? null : null;

    const nextCursor =
      nextPost && typeof nextPost.trendingScore === 'number'
        ? this.encodePopularCursor({
            score: nextPost.trendingScore,
            createdAt: nextPost.createdAt.toISOString(),
            id: nextPost.id,
          })
        : null;

    const scoreByPostId = new Map<string, number>(
      slicePosts
        .filter((p): p is FeedPost & { trendingScore: number } => typeof p.trendingScore === 'number')
        .map((p) => [p.id, p.trendingScore]),
    );

    return { posts: slicePosts, nextCursor, scoreByPostId };
  }

  /**
   * For You feed: a small lane blend, not just a personalized trending sort.
   *
   * Lanes:
   *  - recent unseen posts by authors the viewer follows,
   *  - posts recently engaged by authors the viewer follows,
   *  - low-priority group posts the viewer can read,
   *  - broader trending + chronological discovery.
   *
   * The cursor is opaque and records ids already served by this For You session. That lets the next
   * page recompute fresh rankings while excluding prior rows, avoiding the old scan-boundary skip
   * where lower-ranked candidates inside a scanned window could disappear forever.
   */
  async listForYouFeed(params: {
    viewerUserId: string | null;
    limit: number;
    cursor: string | null;
    visibility: 'all' | PostVisibility;
    kind?: 'regular' | 'checkin' | null;
    checkinDayKey?: string | null;
    /** When true, include the viewer's own posts (overrides home-feed self-exclusion). */
    includeSelf?: boolean;
    mediaOnly?: boolean;
    topLevelOnly?: boolean;
    authorUserIds?: string[] | null;
  }): Promise<PopularFeedResult> {
    const { viewerUserId, limit, cursor, visibility } = params;
    const kind = (params.kind ?? null) as 'regular' | 'checkin' | null;
    const checkinDayKey = (params.checkinDayKey ?? null)?.trim() || null;
    const requestedAuthorUserIds =
      (params.authorUserIds ?? null)?.map((s) => (s ?? '').trim()).filter(Boolean).slice(0, 50) ?? null;
    if (requestedAuthorUserIds && requestedAuthorUserIds.length === 0) {
      return { posts: [], nextCursor: null, scoreByPostId: new Map() };
    }

    const viewer = await this.viewerContextService.getViewer(viewerUserId);
    const allowed = this.enrichment.allowedVisibilitiesForViewer(viewer);

    if (visibility === 'verifiedOnly') {
      if (!viewer || viewer.verifiedStatus === 'none') throw new ForbiddenException('Verify to view verified-only posts.');
    }
    if (visibility === 'premiumOnly') {
      if (!viewer || !this.viewerContextService.isPremium(viewer)) {
        throw new ForbiddenException('Upgrade to premium to view premium-only posts.');
      }
    }

    const baseVisibilityWhere: Prisma.PostWhereInput =
      visibility === 'all'
        ? { visibility: { in: allowed } }
        : visibility === 'public'
          ? { visibility: 'public' }
          : { visibility };

    const blockSets = viewerUserId
      ? await this.enrichment.viewerBlockSets(viewerUserId)
      : { blockedByViewer: new Set<string>(), viewerBlockedBy: new Set<string>() };
    const blockedAuthorIds = [...new Set([...blockSets.blockedByViewer, ...blockSets.viewerBlockedBy])];
    const blockedAuthorSet = new Set(blockedAuthorIds);

    // Author filter: intersect requested authors (if any) with "not the viewer". We don't filter
    // `parentId IS NULL` so engaged replies stay first-class trending candidates — the controller's
    // `collapseFeedByRoot` rolls them up to their root for display.
    // When includeSelf is true (e.g. per-day check-in feeds), the viewer's own posts are kept.
    const userIdWhere: Prisma.PostWhereInput['userId'] =
      requestedAuthorUserIds?.length
        ? { in: requestedAuthorUserIds.filter((id) => id !== viewerUserId && !blockedAuthorSet.has(id)) }
        : blockedAuthorIds.length > 0
          ? params.includeSelf
            ? { notIn: blockedAuthorIds }
            : { notIn: viewerUserId ? [viewerUserId, ...blockedAuthorIds] : blockedAuthorIds }
          : viewerUserId && !params.includeSelf
            ? { not: viewerUserId }
            : undefined;

    if (requestedAuthorUserIds?.length && (userIdWhere as { in: string[] }).in.length === 0) {
      return { posts: [], nextCursor: null, scoreByPostId: new Map() };
    }

    const commonWhere: Prisma.PostWhereInput = {
      deletedAt: null,
      kind: kind ? kind : { not: 'repost' },
      user: { bannedAt: null },
      ...(userIdWhere !== undefined ? { userId: userIdWhere } : {}),
      ...(checkinDayKey ? { checkinDayKey } : {}),
      ...(params.mediaOnly ? mediaOnlyWhere() : {}),
      ...(params.topLevelOnly ? { parentId: null } : {}),
      ...baseVisibilityWhere,
    };
    const baseWhere: Prisma.PostWhereInput = {
      ...commonWhere,
      communityGroupId: null,
    };

    const decodedForYouCursor = this.decodeForYouCursor(cursor);
    const servedIds = decodedForYouCursor.servedIds;
    const servedWhere: Prisma.PostWhereInput[] =
      servedIds.length > 0 ? [{ id: { notIn: servedIds } }] : [];

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
            ...(excludeIds.length > 0 ? ([{ id: { notIn: excludeIds } }] as Prisma.PostWhereInput[]) : []),
          ],
        },
        orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
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
    const inTrendingHead =
      Boolean(cursorRow && cursorRow.trendingScore != null && cursorRow.trendingScore > 0);
    const fallbackOnly = Boolean(legacyCursor) && !inTrendingHead;

    const scanTake = Math.min(POSTS_RANKING.forYouScanTakeMax, Math.max(limit + 10, limit * 4));

    type ScannedRow = {
      id: string;
      userId: string;
      parentId: string | null;
      communityGroupId: string | null;
      createdAt: Date;
      trendingScore: number | null;
    };
    type Candidate = ScannedRow & {
      followingUnseen: boolean;
      friendEngaged: boolean;
      secondDegree: boolean;
      secondDegreePaths: number;
      memberGroup: boolean;
      openFollowGroup: boolean;
      lastFriendEngagementAt: Date | null;
    };
    let trendingScanned: ScannedRow[] = [];
    let chronoScanned: ScannedRow[] = [];
    let discoveryOverflow = false;

    const viewerFollowingRows = viewerUserId
      ? await this.prisma.follow.findMany({
          where: { followerId: viewerUserId },
          select: { followingId: true },
        })
      : [];
    const viewerFollowingIds = [...new Set(viewerFollowingRows.map((r) => r.followingId).filter(Boolean))];
    const followingCandidateIds = requestedAuthorUserIds
      ? viewerFollowingIds.filter((id) => requestedAuthorUserIds.includes(id) && id !== viewerUserId)
      : viewerFollowingIds.filter((id) => id !== viewerUserId);

    const followedSince = new Date(Date.now() - POSTS_RANKING.forYouRecentFollowedWindowHours * 60 * 60 * 1000);
    const secondDegreeSince = new Date(Date.now() - POSTS_RANKING.forYouSecondDegreeWindowHours * 60 * 60 * 1000);
    const groupSince = new Date(Date.now() - POSTS_RANKING.forYouGroupWindowHours * 60 * 60 * 1000);
    const engagedWithSince = new Date(Date.now() - POSTS_RANKING.forYouEngagedWithWindowDays * 24 * 60 * 60 * 1000);
    const directNetworkExcludedIds = [...new Set([...(viewerUserId ? [viewerUserId] : []), ...viewerFollowingIds, ...blockedAuthorIds])];
    // Group posts are excluded from home feeds. These lanes are intentionally dormant:
    // memberGroupIds and viewerCanReadOpenGroups are forced to empty/false so the
    // member-group and open-follow-group candidate queries (below) always resolve to [].
    const memberGroupIds: string[] = [];
    const viewerCanReadOpenGroups = false;
    const secondDegreePathCountByAuthor = new Map<string, number>();
    if (viewerFollowingIds.length > 0) {
      const secondDegreeRows = await this.prisma.follow.findMany({
        where: {
          followerId: { in: viewerFollowingIds },
          followingId: requestedAuthorUserIds?.length
            ? { in: requestedAuthorUserIds.filter((id) => !directNetworkExcludedIds.includes(id)) }
            : { notIn: directNetworkExcludedIds },
        },
        select: { followingId: true },
        take: 1000,
      });
      for (const row of secondDegreeRows) {
        const authorId = row.followingId;
        secondDegreePathCountByAuthor.set(authorId, (secondDegreePathCountByAuthor.get(authorId) ?? 0) + 1);
      }
    }
    const secondDegreeAuthorIds = [...secondDegreePathCountByAuthor.entries()]
      .sort((a, b) => {
        if (b[1] !== a[1]) return b[1] - a[1];
        return a[0] < b[0] ? -1 : 1;
      })
      .slice(0, POSTS_RANKING.forYouSecondDegreeMaxAuthors)
      .map(([authorId]) => authorId);

    if (!fallbackOnly) {
      const trendingCursorWhere: Prisma.PostWhereInput[] =
        cursorRow && cursorRow.trendingScore != null && cursorRow.trendingScore > 0
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

      const tRows = (await this.prisma.post.findMany({
        where: { AND: [baseWhere, ...servedWhere, { trendingScore: { gt: 0 } }, ...trendingCursorWhere] },
        orderBy: [{ trendingScore: 'desc' }, { createdAt: 'desc' }, { id: 'desc' }],
        take: scanTake + 1,
        select: { id: true, userId: true, parentId: true, communityGroupId: true, createdAt: true, trendingScore: true },
      })) as ScannedRow[];

      const haveMoreTrending = tRows.length > scanTake;
      trendingScanned = tRows.slice(0, scanTake);
      discoveryOverflow = discoveryOverflow || haveMoreTrending;

      // Trending didn't fill the scan window → supplement with the chrono tail so the page never
      // feels sparse.
      if (!haveMoreTrending && trendingScanned.length < scanTake) {
        const remaining = scanTake - trendingScanned.length;
        const cRows = (await this.prisma.post.findMany({
          where: {
            AND: [baseWhere, ...servedWhere, { OR: [{ trendingScore: 0 }, { trendingScore: null }] }],
          },
          orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
          take: remaining + 1,
          select: { id: true, userId: true, parentId: true, communityGroupId: true, createdAt: true, trendingScore: true },
        })) as ScannedRow[];

        const haveMoreChrono = cRows.length > remaining;
        chronoScanned = cRows.slice(0, remaining);
        discoveryOverflow = discoveryOverflow || haveMoreChrono;
      }
    } else {
      const chronoCursorWhere: Prisma.PostWhereInput[] = cursorRow
        ? [
            {
              OR: [
                { createdAt: { lt: cursorRow.createdAt } },
                {
                  AND: [{ createdAt: cursorRow.createdAt }, { id: { lt: cursorRow.id } }],
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
        orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
        take: scanTake + 1,
        select: { id: true, userId: true, parentId: true, communityGroupId: true, createdAt: true, trendingScore: true },
      })) as ScannedRow[];

      const haveMoreChrono = cRows.length > scanTake;
      chronoScanned = cRows.slice(0, scanTake);
      discoveryOverflow = discoveryOverflow || haveMoreChrono;
    }

    const [followedRowsRaw, friendRowsRaw, secondDegreeRowsRaw, memberGroupRowsRaw, openFollowGroupRowsRaw] = await Promise.all([
      followingCandidateIds.length > 0
        ? this.prisma.post.findMany({
            where: {
              AND: [
                baseWhere,
                ...servedWhere,
                { userId: { in: followingCandidateIds } },
                { createdAt: { gte: followedSince } },
                // followingCandidateIds.length > 0 implies viewerUserId is non-null
                { views: { none: { userId: viewerUserId! } } },
              ],
            },
            orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
            take: scanTake + 1,
            select: { id: true, userId: true, parentId: true, communityGroupId: true, createdAt: true, trendingScore: true },
          }) as Promise<ScannedRow[]>
        : Promise.resolve([] as ScannedRow[]),
      viewerFollowingIds.length > 0
        ? this.prisma.post.findMany({
            where: {
              AND: [
                baseWhere,
                ...servedWhere,
                {
                  OR: [
                    { boosts: { some: { userId: { in: viewerFollowingIds } } } },
                    { replies: { some: { userId: { in: viewerFollowingIds }, deletedAt: null } } },
                  ],
                },
              ],
            },
            orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
            take: scanTake + 1,
            select: { id: true, userId: true, parentId: true, communityGroupId: true, createdAt: true, trendingScore: true },
          }) as Promise<ScannedRow[]>
        : Promise.resolve([] as ScannedRow[]),
      secondDegreeAuthorIds.length > 0
        ? this.prisma.post.findMany({
            where: {
              AND: [
                baseWhere,
                ...servedWhere,
                { userId: { in: secondDegreeAuthorIds } },
                { createdAt: { gte: secondDegreeSince } },
              ],
            },
            orderBy: [{ trendingScore: 'desc' }, { createdAt: 'desc' }, { id: 'desc' }],
            take: scanTake + 1,
            select: { id: true, userId: true, parentId: true, communityGroupId: true, createdAt: true, trendingScore: true },
          }) as Promise<ScannedRow[]>
        : Promise.resolve([] as ScannedRow[]),
      memberGroupIds.length > 0
        ? this.prisma.post.findMany({
            where: {
              AND: [
                commonWhere,
                ...servedWhere,
                { communityGroupId: { in: memberGroupIds } },
                { createdAt: { gte: groupSince } },
              ],
            },
            orderBy: [{ trendingScore: 'desc' }, { createdAt: 'desc' }, { id: 'desc' }],
            take: scanTake + 1,
            select: { id: true, userId: true, parentId: true, communityGroupId: true, createdAt: true, trendingScore: true },
          }) as Promise<ScannedRow[]>
        : Promise.resolve([] as ScannedRow[]),
      viewerCanReadOpenGroups && followingCandidateIds.length > 0
        ? this.prisma.post.findMany({
            where: {
              AND: [
                commonWhere,
                ...servedWhere,
                { userId: { in: followingCandidateIds } },
                memberGroupIds.length > 0
                  ? { communityGroupId: { notIn: memberGroupIds } }
                  : { communityGroupId: { not: null } },
                { communityGroup: { is: { deletedAt: null, joinPolicy: 'open' } } },
                { createdAt: { gte: groupSince } },
              ],
            },
            orderBy: [{ trendingScore: 'desc' }, { createdAt: 'desc' }, { id: 'desc' }],
            take: scanTake + 1,
            select: { id: true, userId: true, parentId: true, communityGroupId: true, createdAt: true, trendingScore: true },
          }) as Promise<ScannedRow[]>
        : Promise.resolve([] as ScannedRow[]),
    ]);

    const followedOverflow = followedRowsRaw.length > scanTake;
    const friendOverflow = friendRowsRaw.length > scanTake;
    const secondDegreeOverflow = secondDegreeRowsRaw.length > scanTake;
    const memberGroupOverflow = memberGroupRowsRaw.length > scanTake;
    const openFollowGroupOverflow = openFollowGroupRowsRaw.length > scanTake;
    const followedRows = followedRowsRaw.slice(0, scanTake);
    const friendRows = friendRowsRaw.slice(0, scanTake);
    const secondDegreeRows = secondDegreeRowsRaw.slice(0, scanTake);
    const memberGroupRows = memberGroupRowsRaw.slice(0, scanTake);
    const openFollowGroupRows = openFollowGroupRowsRaw.slice(0, scanTake);

    const candidateById = new Map<string, Candidate>();
    const addRows = (rows: ScannedRow[], lane: 'following' | 'friend' | 'secondDegree' | 'memberGroup' | 'openFollowGroup' | 'discovery') => {
      for (const row of rows) {
        const existing = candidateById.get(row.id);
        if (existing) {
          if (lane === 'following') existing.followingUnseen = true;
          if (lane === 'friend') existing.friendEngaged = true;
          if (lane === 'secondDegree') {
            existing.secondDegree = true;
            existing.secondDegreePaths = Math.max(existing.secondDegreePaths, secondDegreePathCountByAuthor.get(row.userId) ?? 1);
          }
          if (lane === 'memberGroup') existing.memberGroup = true;
          if (lane === 'openFollowGroup') existing.openFollowGroup = true;
          continue;
        }
        candidateById.set(row.id, {
          ...row,
          followingUnseen: lane === 'following',
          friendEngaged: lane === 'friend',
          secondDegree: lane === 'secondDegree',
          secondDegreePaths: lane === 'secondDegree' ? (secondDegreePathCountByAuthor.get(row.userId) ?? 1) : 0,
          memberGroup: lane === 'memberGroup',
          openFollowGroup: lane === 'openFollowGroup',
          lastFriendEngagementAt: null,
        });
      }
    };

    addRows(followedRows, 'following');
    addRows(friendRows, 'friend');
    addRows(secondDegreeRows, 'secondDegree');
    addRows(memberGroupRows, 'memberGroup');
    addRows(openFollowGroupRows, 'openFollowGroup');
    addRows(trendingScanned, 'discovery');
    addRows(chronoScanned, 'discovery');

    const candidates = [...candidateById.values()];
    if (candidates.length === 0) {
      const fallback = await fetchChronologicalMediaFallback(limit, []);
      if (fallback.posts.length > 0) {
        const fallbackIds = fallback.posts.map((p) => p.id);
        return {
          posts: fallback.posts,
          nextCursor: fallback.overflow ? this.encodeForYouCursor([...servedIds, ...fallbackIds]) : null,
          scoreByPostId: new Map(fallbackIds.map((id) => [id, 0])),
        };
      }
      return { posts: [], nextCursor: null, scoreByPostId: new Map() };
    }

    const candidateIds = candidates.map((c) => c.id);
    const authorIds = [...new Set(candidates.map((c) => c.userId))];
    const friendEngagedIds = candidates.filter((c) => c.friendEngaged).map((c) => c.id);

    const [followerRows, viewedRows, friendBoostRows, friendReplyRows, viewerBoostRows, viewerReplyRows] = await Promise.all([
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
            select: { postId: true, createdAt: true, lastSeenAt: true, seenCount: true, lastSource: true },
          })
        : Promise.resolve([] as Array<{ postId: string; createdAt: Date; lastSeenAt: Date | null; seenCount: bigint | number | null; lastSource: string | null }>),
      // Latest boost timestamp + count of following-users per post. Drives `lastFriendEngagementAt`
      // so an old post with a fresh friend-boost ranks like fresh content, and `_count` feeds the
      // social-proof base score so graph density beats global virality in discovery.
      friendEngagedIds.length > 0 && viewerFollowingIds.length > 0
        ? this.prisma.boost.groupBy({
            by: ['postId'],
            where: { postId: { in: friendEngagedIds }, userId: { in: viewerFollowingIds } },
            _max: { createdAt: true },
            _count: { userId: true },
          })
        : Promise.resolve([] as Array<{ postId: string; _max: { createdAt: Date | null }; _count: { userId: number } }>),
      // Latest reply timestamp + count of following-users per post.
      friendEngagedIds.length > 0 && viewerFollowingIds.length > 0
        ? this.prisma.post.groupBy({
            by: ['parentId'],
            where: {
              parentId: { in: friendEngagedIds },
              userId: { in: viewerFollowingIds },
              deletedAt: null,
            },
            _max: { createdAt: true },
            _count: { userId: true },
          })
        : Promise.resolve([] as Array<{ parentId: string | null; _max: { createdAt: Date | null }; _count: { userId: number } }>),
      // Viewer's own recent boosts — used to identify A+ tier authors (people you actively engage with).
      // Boost has @@unique([postId, userId]) so _count is effectively distinct users.
      viewerUserId
        ? this.prisma.boost.findMany({
            where: { userId: viewerUserId, createdAt: { gte: engagedWithSince } },
            select: { post: { select: { userId: true } } },
            take: 200,
          })
        : Promise.resolve([] as Array<{ post: { userId: string } }>),
      // Viewer's own recent replies — surfaces authors the viewer actively talks to.
      viewerUserId
        ? this.prisma.post.findMany({
            where: { userId: viewerUserId, parentId: { not: null }, createdAt: { gte: engagedWithSince } },
            select: { parent: { select: { userId: true } } },
            take: 200,
          })
        : Promise.resolve([] as Array<{ parent: { userId: string } | null }>),
    ]);

    const youFollow = new Set(viewerFollowingIds);
    const followsYou = new Set(followerRows.map((r) => r.followerId));

    // A+ tier: authors the viewer has recently boosted or replied to (explicit engagement history).
    const engagedWithAuthorIds = new Set<string>([
      ...viewerBoostRows.map((r) => r.post.userId).filter(Boolean),
      ...viewerReplyRows.map((r) => r.parent?.userId).filter((id): id is string => Boolean(id)),
    ]);

    // Social proof count: total engagements from following-users per candidate post.
    // Used to make social-graph density the primary base for discovery slots instead of global trending.
    const socialProofCountById = new Map<string, number>();
    for (const row of friendBoostRows) {
      socialProofCountById.set(row.postId, (socialProofCountById.get(row.postId) ?? 0) + row._count.userId);
    }
    for (const row of friendReplyRows) {
      const pid = row.parentId;
      if (!pid) continue;
      socialProofCountById.set(pid, (socialProofCountById.get(pid) ?? 0) + row._count.userId);
    }

    const seenById = new Map<string, { lastSeenAt: Date; seenCount: number; lastSource: string | null }>(
      viewedRows.map((r) => [
        r.postId,
        {
          lastSeenAt: r.lastSeenAt ?? r.createdAt,
          seenCount: Math.max(1, Math.floor(Number(r.seenCount ?? 1))),
          lastSource: r.lastSource ?? null,
        },
      ]),
    );

    const lastFriendEngagementAt = new Map<string, Date>();
    for (const row of friendBoostRows) {
      const at = row._max.createdAt;
      if (at) lastFriendEngagementAt.set(row.postId, at);
    }
    for (const row of friendReplyRows) {
      const pid = row.parentId;
      const at = row._max.createdAt;
      if (!pid || !at) continue;
      const existing = lastFriendEngagementAt.get(pid);
      if (!existing || at.getTime() > existing.getTime()) lastFriendEngagementAt.set(pid, at);
    }
    for (const c of candidates) {
      if (c.friendEngaged) {
        c.lastFriendEngagementAt = lastFriendEngagementAt.get(c.id) ?? null;
      }
    }

    const now = Date.now();
    const ranked = candidates.map((c) => {
      const youFollowThem = youFollow.has(c.userId);
      const theyFollowYou = followsYou.has(c.userId);
      const youEngagedWithThem = youFollowThem && engagedWithAuthorIds.has(c.userId);
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
      let seenMult = 1.0;
      if (seen) {
        const hours = Math.max(0, (now - seen.lastSeenAt.getTime()) / (60 * 60 * 1000));
        const recovery = 1 - Math.exp(-hours / POSTS_RANKING.forYouSeenHalfLifeHours);
        seenMult = POSTS_RANKING.forYouSeenFloor + (1 - POSTS_RANKING.forYouSeenFloor) * recovery;
        if (seen.seenCount > 1) {
          const repeatPenalty = 1 / (1 + Math.log2(seen.seenCount) * POSTS_RANKING.forYouSeenRepeatPenaltyStrength);
          seenMult *= repeatPenalty;
        }
        if (seen.lastSource === 'feed_scroll' && hours < POSTS_RANKING.forYouRecentFeedSeenExtraPenaltyHours) {
          seenMult *= POSTS_RANKING.forYouRecentFeedSeenExtraPenaltyMult;
        }
      }

      // Only compound the 2.2x bonus when you already follow the author (tiers A/B). For the
      // E tier (friend engaged, stranger/follower author) the social proof is fully captured in
      // forYouFriendCommentedMult — stacking would over-reward the same signal twice.
      const friendMult = c.friendEngaged && youFollowThem ? POSTS_RANKING.forYouFriendEngagementMult : 1.0;
      const followedUnseenMult = c.followingUnseen ? POSTS_RANKING.forYouFollowedUnseenMult : 1.0;
      const secondDegreePathBonus = c.secondDegree
        ? Math.min(POSTS_RANKING.forYouSecondDegreePathBonusMax, 1 + Math.max(0, c.secondDegreePaths - 1) * 0.15)
        : 1.0;
      const secondDegreeMult = c.secondDegree ? POSTS_RANKING.forYouSecondDegreeMult * secondDegreePathBonus : 1.0;
      const groupMult = c.memberGroup
        ? POSTS_RANKING.forYouMemberGroupMult
        : c.openFollowGroup
          ? POSTS_RANKING.forYouOpenFollowGroupMult
          : 1.0;
      // Effective age uses the freshest of (post createdAt, latest friend engagement) — a months-old
      // post with a 2h-ago reply from someone the viewer follows ranks like fresh content.
      const friendEngagementMs = c.lastFriendEngagementAt?.getTime() ?? 0;
      const effectiveAtMs = Math.max(c.createdAt.getTime(), friendEngagementMs);
      const ageHours = Math.max(0, (now - effectiveAtMs) / (60 * 60 * 1000));
      const decay =
        POSTS_RANKING.forYouRecencyFloor +
        (1 - POSTS_RANKING.forYouRecencyFloor) * Math.exp(-ageHours / POSTS_RANKING.forYouRecencyHalfLifeHours);
      const freshBoost =
        ageHours < 24
          ? POSTS_RANKING.forYouFreshBoost24h
          : ageHours < 48
            ? POSTS_RANKING.forYouFreshBoost48h
            : 1.0;
      const recencyMult = decay * freshBoost;

      // Base score is user-first, not content-first:
      //   - Friend-engaged: social proof (N follows who engaged × weight) dominates over global trending,
      //     so a post engaged by 3 of your follows outranks a viral post with zero social connection.
      //   - Pure discovery (no social connection to author + no second-degree/group signal): global
      //     trending is demoted 40% so strangers' viral content doesn't crowd out social posts.
      //     We check the RELATIONSHIP (youFollowThem/theyFollowYou), not lane flags, because a seen
      //     post from a followed author only enters via trending scan (followingUnseen=false) but still
      //     has a social connection and must NOT be demoted.
      //   - All other cases (author in social graph, second-degree, groups): use trendingScore as-is.
      const rawTrending = c.trendingScore != null && c.trendingScore > 0 ? c.trendingScore : 1.0;
      const socialProofCount = socialProofCountById.get(c.id) ?? 0;
      const noSocialConnection = !youFollowThem && !theyFollowYou && !c.secondDegree && !c.memberGroup && !c.openFollowGroup;
      let rawBase: number;
      if (c.friendEngaged) {
        const socialBase = socialProofCount * POSTS_RANKING.forYouSocialProofBaseWeight;
        rawBase = Math.max(socialBase, rawTrending);
      } else if (noSocialConnection) {
        rawBase = rawTrending * 0.4;
      } else {
        rawBase = rawTrending;
      }
      const base = c.friendEngaged ? Math.max(rawBase, POSTS_RANKING.forYouFriendEngagementBaseFloor) : rawBase;
      const jitter =
        viewerUserId == null
          ? 1 + (Math.random() * 2 - 1) * POSTS_RANKING.forYouAnonJitterStrength
          : 1;
      const adjusted = base * recencyMult * relMult * seenMult * friendMult * followedUnseenMult * secondDegreeMult * groupMult * jitter;
      return { candidate: c, adjusted };
    });

    ranked.sort((a, b) => {
      if (b.adjusted !== a.adjusted) return b.adjusted - a.adjusted;
      if (a.candidate.followingUnseen !== b.candidate.followingUnseen) return a.candidate.followingUnseen ? -1 : 1;
      if (a.candidate.friendEngaged !== b.candidate.friendEngaged) return a.candidate.friendEngaged ? -1 : 1;
      const aBase = a.candidate.trendingScore ?? 0;
      const bBase = b.candidate.trendingScore ?? 0;
      if (bBase !== aBase) return bBase - aBase;
      const at = a.candidate.createdAt.getTime();
      const bt = b.candidate.createdAt.getTime();
      if (bt !== at) return bt - at;
      return a.candidate.id < b.candidate.id ? 1 : -1;
    });

    // Per-author diversity is a SOFT constraint: first-pass respects the window so a single
    // prolific author can't dominate when there's a populated universe; second-pass fills any
    // leftover slots from the skipped pile in rank order so a sparse universe (e.g.
    // verifiedOnly with few authors) never returns near-empty pages or churns its single
    // visible row as the seen-decay shuffles things between requests.
    const window = Math.max(1, POSTS_RANKING.forYouMaxPerAuthorWindow);
    const picked: typeof ranked = [];
    const pickedIdSet = new Set<string>();
    const skipped: typeof ranked = [];

    const recentAuthors: string[] = [];
    const recentRoots: string[] = [];
    const pickFrom = (source: typeof ranked, maxPicked: number) => {
      for (const r of source) {
        if (picked.length >= maxPicked) break;
        if (pickedIdSet.has(r.candidate.id)) continue;
        const rootKey = r.candidate.parentId ?? r.candidate.id;
        if (recentAuthors.includes(r.candidate.userId) || recentRoots.includes(rootKey)) {
          skipped.push(r);
          continue;
        }
        picked.push(r);
        pickedIdSet.add(r.candidate.id);
        recentAuthors.push(r.candidate.userId);
        recentRoots.push(rootKey);
        if (recentAuthors.length >= window) recentAuthors.shift();
        if (recentRoots.length >= window) recentRoots.shift();
      }
    };

    // Depth-aware quota: the feed fans out from user-first toward social discovery as the viewer
    // scrolls deeper. servedIds.length is the number of posts already served in this session.
    const paginationDepth = servedIds.length;
    const followedUnseenRatio =
      paginationDepth === 0
        ? 0.70  // page 1: strongly user-first (people you follow dominate)
        : paginationDepth <= 50
          ? 0.55  // page 2: still follow-heavy but opens discovery
          : 0.40; // page 3+: fans out into friend-engaged + second-degree
    const followedQuota = Math.min(limit, Math.ceil(limit * followedUnseenRatio));
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
        const aAgeH = Math.max(0, (now - a.candidate.createdAt.getTime()) / (60 * 60 * 1000));
        const bAgeH = Math.max(0, (now - b.candidate.createdAt.getTime()) / (60 * 60 * 1000));
        const aBucket = Math.floor(aAgeH / bucketHours);
        const bBucket = Math.floor(bAgeH / bucketHours);
        if (aBucket !== bBucket) return aBucket - bBucket;
        // Within bucket: engaged-with authors first (A+ tier), then mutuals (A), then one-way.
        const aEngaged = engagedWithAuthorIds.has(a.candidate.userId);
        const bEngaged = engagedWithAuthorIds.has(b.candidate.userId);
        if (aEngaged !== bEngaged) return aEngaged ? -1 : 1;
        const aMutual = youFollow.has(a.candidate.userId) && followsYou.has(a.candidate.userId);
        const bMutual = youFollow.has(b.candidate.userId) && followsYou.has(b.candidate.userId);
        if (aMutual !== bMutual) return aMutual ? -1 : 1;
        return b.candidate.createdAt.getTime() - a.candidate.createdAt.getTime();
      });
    pickFrom(followedUnseenSorted, followedQuota);
    pickFrom(ranked, limit);

    if (picked.length < limit && skipped.length > 0) {
      for (const r of skipped) {
        if (picked.length >= limit) break;
        if (pickedIdSet.has(r.candidate.id)) continue;
        picked.push(r);
        pickedIdSet.add(r.candidate.id);
      }
    }

    const pickedIds = picked.map((p) => p.candidate.id);
    const posts = pickedIds.length
      ? ((await this.prisma.post.findMany({
          where: { id: { in: pickedIds }, ...notDeletedWhere() },
          include: params.mediaOnly ? mediaFeedPostInclude : feedPostInclude,
        })) as FeedPost[])
      : [];
    const byId = new Map(posts.map((p) => [p.id, p] as const));
    let ordered = pickedIds.map((id) => byId.get(id)).filter((p): p is FeedPost => Boolean(p));
    const fallback = await fetchChronologicalMediaFallback(limit - ordered.length, pickedIds);
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
    const nextCursor = moreAvailable ? this.encodeForYouCursor([...servedIds, ...orderedIds]) : null;

    const scoreByPostId = new Map<string, number>(picked.map((p) => [p.candidate.id, p.adjusted]));
    for (const post of fallback.posts) scoreByPostId.set(post.id, 0);

    return { posts: ordered, nextCursor, scoreByPostId };
  }

  /** Featured/Explore feed: reads directly from Post.trendingScore, with per-author diversity and a "rising" blend. */
  private async listFeaturedFeedFromScore(params: {
    viewerUserId: string | null;
    limit: number;
    decodedCursor: { score: number; createdAt: string; id: string } | null;
    visibility: 'all' | PostVisibility;
    allowed: PostVisibility[];
    authorUserIds: string[] | null;
    mediaOnly?: boolean;
    topLevelOnly?: boolean;
  }): Promise<PopularFeedResult> {
    const { viewerUserId, limit, decodedCursor, visibility, allowed, authorUserIds } = params;
    const now = new Date();

    const baseVisibilityWhere: Prisma.PostWhereInput =
      visibility === 'all'
        ? { visibility: { in: allowed } }
        : visibility === 'public'
          ? { visibility: 'public' }
          : { visibility };

    const visibilityWhere: Prisma.PostWhereInput =
      viewerUserId && visibility === 'all'
        ? { OR: [baseVisibilityWhere, { userId: viewerUserId, visibility: { not: 'onlyMe' } }] }
        : baseVisibilityWhere;

    const lookbackMs = POSTS_RANKING.featuredLookbackDays * 24 * 60 * 60 * 1000;
    const featuredMinCreatedAt = new Date(now.getTime() - lookbackMs);

    const cursorScore = decodedCursor?.score ?? null;
    const cursorCreatedAt = decodedCursor ? new Date(decodedCursor.createdAt) : null;
    const cursorId = decodedCursor?.id ?? null;

    // Subsequent pages: trendingScore-ordered fetch with per-author diversity.
    if (decodedCursor && cursorScore != null && cursorCreatedAt && cursorId) {
      const scanTake = Math.min(POSTS_RANKING.featuredScanTakeMax, Math.max(limit * 40, limit + 1));
      const rows = await this.prisma.post.findMany({
        where: {
          deletedAt: null,
          communityGroupId: null,
          trendingScore: { gt: 0 },
          kind: { not: 'repost' },
          parentId: null,
          createdAt: { gte: featuredMinCreatedAt },
          user: { bannedAt: null },
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
                {
                  OR: [
                    { createdAt: { lt: cursorCreatedAt } },
                    { AND: [{ createdAt: cursorCreatedAt }, { id: { lt: cursorId } }] },
                  ],
                },
              ],
            },
          ],
        },
        orderBy: [{ trendingScore: 'desc' }, { createdAt: 'desc' }, { id: 'desc' }],
        take: scanTake,
        select: { id: true, createdAt: true, trendingScore: true, userId: true },
      }) as Array<{ id: string; createdAt: Date; trendingScore: number; userId: string }>;

      const picked: typeof rows = [];
      const perAuthor = new Map<string, number>();
      for (const r of rows) {
        if (picked.length >= limit + 1) break;
        const n = perAuthor.get(r.userId) ?? 0;
        if (n >= POSTS_RANKING.featuredMaxPerAuthor) continue;
        perAuthor.set(r.userId, n + 1);
        picked.push(r);
      }

      const sliceRows = picked.slice(0, limit);
      const ids = sliceRows.map((r) => r.id);
      const boundaryRow = sliceRows.length > 0 ? sliceRows[sliceRows.length - 1] : null;

      const posts = ids.length
        ? await this.prisma.post.findMany({ where: { id: { in: ids }, ...notDeletedWhere() }, include: feedPostInclude })
        : [];
      const byId = new Map(posts.map((p) => [p.id, p] as const));
      const ordered = ids.map((id) => byId.get(id)).filter((p): p is (typeof posts)[number] => Boolean(p));

      const nextCursor =
        picked.length > limit && boundaryRow
          ? this.encodePopularCursor({ score: boundaryRow.trendingScore, createdAt: boundaryRow.createdAt.toISOString(), id: boundaryRow.id })
          : null;

      const scoreByPostId = new Map<string, number>(sliceRows.map((r) => [r.id, r.trendingScore]));
      return { posts: ordered, nextCursor, scoreByPostId };
    }

    // First page: blend top-scored posts + "rising" fresh posts for variety.
    const topTake = Math.max(1, Math.min(limit, Math.round(limit * POSTS_RANKING.featuredRisingMixTopRatio)));
    const risingTake = Math.max(0, limit - topTake);
    const scanTake = Math.min(POSTS_RANKING.featuredScanTakeMax, Math.max(topTake * 10, topTake + 1));

    const topRows = await this.prisma.post.findMany({
      where: {
        deletedAt: null,
        communityGroupId: null,
        trendingScore: { gt: 0 },
        kind: { not: 'repost' },
        parentId: null,
        createdAt: { gte: featuredMinCreatedAt },
        user: { bannedAt: null },
        ...(viewerUserId ? { userId: { not: viewerUserId } } : {}),
        ...(authorUserIds?.length ? { userId: { in: authorUserIds } } : {}),
        ...(params.mediaOnly ? mediaOnlyWhere() : {}),
        ...(params.topLevelOnly ? { parentId: null } : {}),
        ...visibilityWhere,
      },
      orderBy: [{ trendingScore: 'desc' }, { createdAt: 'desc' }, { id: 'desc' }],
      take: scanTake,
      select: { id: true, createdAt: true, trendingScore: true, userId: true },
    }) as Array<{ id: string; createdAt: Date; trendingScore: number; userId: string }>;

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
    const topBoundaryRow = topSlice.length > 0 ? topSlice[topSlice.length - 1] : null;
    const nextCursor =
      topPicked.length > topTake && topBoundaryRow
        ? this.encodePopularCursor({ score: topBoundaryRow.trendingScore, createdAt: topBoundaryRow.createdAt.toISOString(), id: topBoundaryRow.id })
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

    const excludeSelfSql = viewerUserId ? Prisma.sql`AND p."userId" <> ${viewerUserId}` : Prisma.sql``;
    const authorFilterSql =
      authorUserIds?.length
        ? Prisma.sql`AND p."userId" IN (${Prisma.join(authorUserIds.map((id) => Prisma.sql`${id}`))})`
        : Prisma.sql``;
    const mediaOnlySql = params.mediaOnly
      ? Prisma.sql`AND EXISTS (SELECT 1 FROM "PostMedia" pm WHERE pm."postId" = p."id" AND pm."deletedAt" IS NULL)`
      : Prisma.sql``;
    const featuredTopLevelOnlySql = params.topLevelOnly ? Prisma.sql`AND p."parentId" IS NULL` : Prisma.sql``;

    const risingWindowMs = POSTS_RANKING.featuredRisingWindowHours * 60 * 60 * 1000;
    const risingMinCreatedAt = new Date(now.getTime() - risingWindowMs);

    const risingVisibilitiesForQuery: PostVisibility[] =
      visibility === 'all' ? allowed : visibility === 'public' ? (['public'] as PostVisibility[]) : ([visibility] as PostVisibility[]);
    const risingVisibilitiesForQuerySql = risingVisibilitiesForQuery.map((v) => Prisma.sql`${v}::"PostVisibility"`);
    const risingVisibilityFilterSql = Prisma.sql`AND p."visibility" IN (${Prisma.join(risingVisibilitiesForQuerySql)})`;

    const risingRows =
      risingTake > 0
        ? await this.prisma.$queryRaw<Array<{ id: string; createdAt: Date; score: number; userId: string }>>(Prisma.sql`
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
                AND p."communityGroupId" IS NULL
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
                    CASE
                    WHEN p."boostScore" IS NULL OR p."boostScoreUpdatedAt" IS NULL THEN 0
                    ELSE p."boostScore" * POWER(
                      0.5,
                      GREATEST(
                        0,
                        EXTRACT(EPOCH FROM (${now}::timestamptz - p."createdAt"))
                      ) / ${POSTS_RANKING.featuredRisingHalfLifeSeconds}
                    )
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
                          ELSE p."boostScore" * POWER(0.5, GREATEST(0, EXTRACT(EPOCH FROM (${now}::timestamptz - p."createdAt")) / ${POSTS_RANKING.featuredRisingHalfLifeSeconds})) END
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

    const risingPicked: Array<{ id: string; createdAt: Date; score: number; userId: string }> = [];
    for (const r of risingRows) {
      if (risingPicked.length >= risingTake) break;
      const n = perAuthor.get(r.userId) ?? 0;
      if (n >= POSTS_RANKING.featuredMaxPerAuthor) continue;
      perAuthor.set(r.userId, n + 1);
      risingPicked.push({ id: r.id, createdAt: r.createdAt, score: r.score, userId: r.userId });
    }

    // Interleave so Explore doesn't show "2 old + 1 new" clumped.
    // topSlice entries have `trendingScore`; normalize to a unified `score` field.
    const combined: Array<{ id: string; score: number }> = [];
    const topQueue = topSlice.map((r) => ({ id: r.id, score: r.trendingScore }));
    const risingQueue = risingPicked.map((r) => ({ id: r.id, score: r.score }));
    while (combined.length < limit && (topQueue.length > 0 || risingQueue.length > 0)) {
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
    const ordered = ids.map((id) => byId.get(id)).filter((p): p is (typeof posts)[number] => Boolean(p));

    const scoreByPostId = new Map<string, number>(combined.map((r) => [r.id, r.score]));
    return { posts: ordered, nextCursor, scoreByPostId };
  }

  /**
   * Trending feed: same half-life boost + bookmark scoring everywhere.
   * Scope: site-wide (authorUserIds null), or only from authors [viewer + followed] (home "following"), or one user (profile).
   */
  async listPopularFeed(params: {
    viewerUserId: string | null;
    limit: number;
    cursor: string | null;
    visibility: 'all' | PostVisibility;
    followingOnly?: boolean;
    kind?: 'regular' | 'checkin' | null;
    checkinDayKey?: string | null;
    /** When true, include the viewer's own posts (overrides home-feed self-exclusion). */
    includeSelf?: boolean;
    mediaOnly?: boolean;
    topLevelOnly?: boolean;
    authorUserIds?: string[] | null;
  }): Promise<PopularFeedResult> {
    const { viewerUserId, limit, cursor, visibility, followingOnly = false } = params;
    const requestedAuthorUserIds =
      (params.authorUserIds ?? null)?.map((s) => (s ?? '').trim()).filter(Boolean).slice(0, 50) ?? null;
    const kind = (params.kind ?? null) as 'regular' | 'checkin' | null;
    const checkinDayKey = (params.checkinDayKey ?? null)?.trim() || null;

    const viewer = await this.viewerContextService.getViewer(viewerUserId);
    const allowed = this.enrichment.allowedVisibilitiesForViewer(viewer);

    if (visibility === 'verifiedOnly') {
      if (!viewer || viewer.verifiedStatus === 'none') throw new ForbiddenException('Verify to view verified-only posts.');
    }
    if (visibility === 'premiumOnly') {
      if (!viewer || !this.viewerContextService.isPremium(viewer)) {
        throw new ForbiddenException('Upgrade to premium to view premium-only posts.');
      }
    }

    if (followingOnly && !viewerUserId) {
      return { posts: [], nextCursor: null, scoreByPostId: new Map() };
    }

    const followingAuthorIds: string[] | null =
      followingOnly && viewerUserId ? await this.getAuthorIdsForFollowingFilter(viewerUserId) : null;

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
      visibility === 'all'
        ? ({ visibility: { in: allowed } } as Prisma.PostWhereInput)
        : visibility === 'public'
          ? ({ visibility: 'public' } as Prisma.PostWhereInput)
          : ({ visibility } as Prisma.PostWhereInput);

    const visibilitiesForQuery: PostVisibility[] =
      visibility === 'all' ? allowed : visibility === 'public' ? (['public'] as PostVisibility[]) : ([visibility] as PostVisibility[]);
    const visibilitiesForQuerySql = visibilitiesForQuery.map((v) => Prisma.sql`${v}::"PostVisibility"`);

    const decoded = this.decodePopularCursor(cursor);

    // Exclude the viewer's own posts from home feeds (Following + All) unless the feed
    // is explicitly scoped to a set of author IDs (e.g. profile view, crew feed),
    // or the caller explicitly opts in with includeSelf (e.g. per-day check-in feeds).
    // Use requestedAuthorUserIds (not authorUserIds) as the gate so the trending Following
    // path (where authorUserIds already excludes the viewer via getAuthorIdsForFollowingFilter)
    // doesn't double-apply the exclusion.
    const excludeViewerAuthor = Boolean(viewerUserId) && !requestedAuthorUserIds?.length && !params.includeSelf;

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
      });
    }

    // Stable pagination: use now as the scoring reference time.
    // Minor inconsistency across pages is acceptable for kind-filtered views (real-time feed).
    const asOf = new Date();
    const asOfMs = asOf.getTime();
    const lookbackMs = POSTS_RANKING.popularLookbackDays * 24 * 60 * 60 * 1000;
    // When scoped to a specific check-in day the day key is the natural date bound —
    // skip the rolling lookback window so historical day feeds are never empty.
    const minCreatedAt = checkinDayKey ? new Date(0) : new Date(asOfMs - lookbackMs);

    const warmupAuthorFilter = authorUserIds?.length
      ? ({ userId: { in: authorUserIds } } as Prisma.PostWhereInput)
      : undefined;
    const warmupKindFilter = kind ? ({ kind } as Prisma.PostWhereInput) : undefined;
    const warmupCheckinDayKeyFilter = checkinDayKey ? ({ checkinDayKey } as Prisma.PostWhereInput) : undefined;
    const warmupTopLevelFilter = params.topLevelOnly ? ({ parentId: null } as Prisma.PostWhereInput) : undefined;

    // IMPORTANT: Only apply "author sees own posts" override when visibility='all'.
    // When user explicitly filters by a specific visibility, respect that filter even for their own posts.
    const popularVisibilityWhere =
      viewerUserId && visibility === 'all'
        ? ({
            OR: [
              visibilityWhere,
              // Author sees own posts (e.g. after tier downgrade), but never include only-me outside /only-me.
              { userId: viewerUserId, visibility: { not: 'onlyMe' } },
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
            ...(excludeViewerAuthor && viewerUserId ? ([{ NOT: { userId: viewerUserId } }] as Prisma.PostWhereInput[]) : []),
            ...(warmupKindFilter ? [warmupKindFilter] : []),
            ...(warmupCheckinDayKeyFilter ? [warmupCheckinDayKeyFilter] : []),
            ...(warmupTopLevelFilter ? [warmupTopLevelFilter] : []),
            notDeletedWhere(),
            userNotBannedWhere(),
            { createdAt: { gte: minCreatedAt } },
            { boostCount: { gt: 0 } },
            { OR: [{ boostScoreUpdatedAt: null }, { boostScoreUpdatedAt: { lt: staleBefore } }] },
          ],
        },
        orderBy: [{ boostCount: 'desc' }, { createdAt: 'desc' }, { id: 'desc' }],
        take: POSTS_RANKING.popularWarmupTake,
        select: { id: true },
      });

      await this.ranking.ensureBoostScoresFresh(warmup.map((p) => p.id));
    }

    // Snapshot `asOf` *after* any warmup updates, so we never "amplify" scores.
    const snapshotAsOf = decoded ? asOf : new Date();
    // For day-scoped feeds the lookback is irrelevant — use epoch so no posts are dropped.
    const snapshotMinCreatedAt = checkinDayKey ? new Date(0) : new Date(snapshotAsOf.getTime() - lookbackMs);
    // recentCutoff is only meaningful for the "recency bucket" on global feeds.
    // For day-scoped feeds set it to epoch so the recency bucket captures everything.
    const recentCutoff = checkinDayKey
      ? new Date(0)
      : new Date(snapshotAsOf.getTime() - POSTS_RANKING.popularRecentWindowHours * 60 * 60 * 1000);

    const cursorCreatedAt = decoded ? new Date(decoded.createdAt) : null;
    const cursorScore = decoded?.score ?? null;
    const cursorId = decoded?.id ?? null;

    const authorFilterSql =
      authorUserIds?.length
        ? Prisma.sql`AND p."userId" IN (${Prisma.join(authorUserIds.map((id) => Prisma.sql`${id}`))})`
        : Prisma.sql``;
    const excludeSelfSql = excludeViewerAuthor && viewerUserId
      ? Prisma.sql`AND p."userId" <> ${viewerUserId}`
      : Prisma.sql``;
    // NOTE: Postgres enum compare requires matching enum type. Cast to text to safely compare against our string param.
    const kindFilterSql = kind ? Prisma.sql`AND (p."kind"::text = ${kind})` : Prisma.sql``;
    const checkinDayKeyFilterSql = checkinDayKey ? Prisma.sql`AND p."checkinDayKey" = ${checkinDayKey}` : Prisma.sql``;
    const topLevelOnlySql = params.topLevelOnly ? Prisma.sql`AND p."parentId" IS NULL` : Prisma.sql``;

    // IMPORTANT: Only apply "author sees own posts" override when visibility='all'.
    // When user explicitly filters by a specific visibility, respect that filter even for their own posts.
    const visibilityFilterSql =
      viewerUserId && visibility === 'all'
        ? Prisma.sql`AND (p."visibility" IN (${Prisma.join(visibilitiesForQuerySql)}) OR (p."userId" = ${viewerUserId} AND p."visibility" <> 'onlyMe'))`
        : Prisma.sql`AND p."visibility" IN (${Prisma.join(visibilitiesForQuerySql)})`;

    const bannedAuthorSql = Prisma.sql`AND (SELECT u."bannedAt" FROM "User" u WHERE u."id" = p."userId") IS NULL`;

    const rows = await this.prisma.$queryRaw<Array<{ id: string; createdAt: Date; score: number }>>(Prisma.sql`
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
              AND p."kind"::text <> 'repost'
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
        JOIN "Post" _cg ON _cg."id" = u."id" AND _cg."communityGroupId" IS NULL
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
              -- Decay by post age so score reflects "recent engagement on this post," not cache refresh time.
              CASE
              WHEN p."boostScore" IS NULL OR p."boostScoreUpdatedAt" IS NULL THEN 0
              ELSE p."boostScore" * POWER(
                0.5,
                GREATEST(
                  0,
                  EXTRACT(EPOCH FROM (${snapshotAsOf}::timestamptz - p."createdAt"))
                ) / ${POSTS_RANKING.popularHalfLifeSeconds}
              )
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
                    ELSE p."boostScore" * POWER(0.5, GREATEST(0, EXTRACT(EPOCH FROM (${snapshotAsOf}::timestamptz - p."createdAt")) / ${POSTS_RANKING.popularHalfLifeSeconds})) END
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
        -- Flat reposts (kind='repost') are excluded: repostCount on the original already carries their signal.
        WHERE p."kind"::text <> 'repost'
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
    const nextRow = rows.length > limit ? sliceRows[sliceRows.length - 1] ?? null : null;

    const posts = ids.length
      ? await this.prisma.post.findMany({
          where: { id: { in: ids }, ...notDeletedWhere() },
          include: feedPostInclude,
        })
      : [];
    const byId = new Map(posts.map((p) => [p.id, p] as const));
    const ordered = ids.map((id) => byId.get(id)).filter((p): p is (typeof posts)[number] => Boolean(p));

    const nextCursor =
      rows.length > limit && nextRow
        ? this.encodePopularCursor({
            score: nextRow.score,
            createdAt: nextRow.createdAt.toISOString(),
            id: nextRow.id,
          })
        : null;

    const scoreByPostId = new Map<string, number>(sliceRows.map((r) => [r.id, r.score]));
    return { posts: ordered, nextCursor, scoreByPostId };
  }

  /**
   * Featured feed: automated subset of trending (popular), tuned for Explore.
   */
  async listFeaturedFeed(params: {
    viewerUserId: string | null;
    limit: number;
    cursor: string | null;
    visibility: 'all' | PostVisibility;
    followingOnly?: boolean;
    kind?: 'regular' | 'checkin' | null;
    checkinDayKey?: string | null;
    /** When true, include the viewer's own posts (overrides home-feed self-exclusion). */
    includeSelf?: boolean;
    mediaOnly?: boolean;
    topLevelOnly?: boolean;
    authorUserIds?: string[] | null;
  }): Promise<PopularFeedResult> {
    const { viewerUserId, limit, cursor, visibility, followingOnly = false } = params;
    const requestedAuthorUserIds =
      (params.authorUserIds ?? null)?.map((s) => (s ?? '').trim()).filter(Boolean).slice(0, 50) ?? null;
    const kind = (params.kind ?? null) as 'regular' | 'checkin' | null;
    const checkinDayKey = (params.checkinDayKey ?? null)?.trim() || null;

    const viewer = await this.viewerContextService.getViewer(viewerUserId);
    const allowed = this.enrichment.allowedVisibilitiesForViewer(viewer);

    if (visibility === 'verifiedOnly') {
      if (!viewer || viewer.verifiedStatus === 'none') throw new ForbiddenException('Verify to view verified-only posts.');
    }
    if (visibility === 'premiumOnly') {
      if (!viewer || !this.viewerContextService.isPremium(viewer)) {
        throw new ForbiddenException('Upgrade to premium to view premium-only posts.');
      }
    }

    if (followingOnly && !viewerUserId) {
      return { posts: [], nextCursor: null, scoreByPostId: new Map() };
    }

    const followingAuthorIds: string[] | null =
      followingOnly && viewerUserId ? await this.getAuthorIdsForFollowingFilter(viewerUserId) : null;

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
      return await this.listPopularFeed({
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

    const decoded = this.decodePopularCursor(cursor);

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

  async listForUsername(params: {
    viewerUserId: string | null;
    username: string;
    limit: number;
    cursor: string | null;
    visibility: 'all' | PostVisibility;
    includeCounts: boolean;
    sort: 'new' | 'popular';
    topLevelOnly?: boolean;
    /** When true, include posts of all visibility tiers.
     *  Posts the viewer cannot access are returned with viewerCanAccess=false and stripped body/media. */
    includeRestricted?: boolean;
  }) {
    const { viewerUserId, username, limit, cursor, visibility, includeCounts, sort } = params;
    const normalized = (username ?? '').trim();
    if (!normalized) throw new NotFoundException('User not found.');

    const user = await this.prisma.user.findFirst({
      where: { username: { equals: normalized, mode: 'insensitive' } },
      select: { id: true },
    });
    if (!user) throw new NotFoundException('User not found.');

    const viewer = await this.viewerContextService.getViewer(viewerUserId);

    const isSelf = Boolean(viewer && viewer.id === user.id);

    const counts: PostCounts | null = includeCounts
      ? await (async () => {
          const grouped = await this.prisma.post.groupBy({
            by: ['visibility'],
            where: {
              userId: user.id,
              visibility: { not: 'onlyMe' },
              ...notDeletedWhere(),
              ...excludeCommunityGroupPostsWhere(),
            },
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
            if (g.visibility === 'public') out.public = n;
            if (g.visibility === 'verifiedOnly') out.verifiedOnly = n;
            if (g.visibility === 'premiumOnly') out.premiumOnly = n;
          }
          return out;
        })()
      : null;

    const allowed =
      isSelf ? (['public', 'verifiedOnly', 'premiumOnly'] as PostVisibility[]) : this.enrichment.allowedVisibilitiesForViewer(viewer);

    if (!params.includeRestricted) {
      if (visibility === 'verifiedOnly' && !isSelf) {
        if (!viewer || viewer.verifiedStatus === 'none') throw new ForbiddenException('Verify to view verified-only posts.');
      }
      if (visibility === 'premiumOnly' && !isSelf) {
        if (!viewer || !this.viewerContextService.isPremium(viewer)) {
          throw new ForbiddenException('Upgrade to premium to view premium-only posts.');
        }
      }
    }

    const topLevelFilter: Prisma.PostWhereInput = params.topLevelOnly ? { parentId: null } : {};

    // When includeRestricted=true, omit visibility filter so all tiers are returned.
    const allVisibilities: PostVisibility[] = ['public', 'verifiedOnly', 'premiumOnly'];
    const effectiveAllowed = params.includeRestricted ? allVisibilities : allowed;

    const baseWhere =
      params.includeRestricted || visibility === 'all'
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

    if (sort === 'popular') {
      // Trending for profile: same half-life boost + bookmark scoring as home feed, scoped to this user.
      const visibilitiesForQuery: PostVisibility[] =
        visibility === 'all' ? allowed : visibility === 'public' ? (['public'] as PostVisibility[]) : ([visibility] as PostVisibility[]);
      const visibilitiesForQuerySql = visibilitiesForQuery.map((v) => Prisma.sql`${v}::"PostVisibility"`);

      const decoded = this.decodePopularCursor(cursor);
      const asOf = new Date();
      const asOfMs = asOf.getTime();
      const lookbackMs = POSTS_RANKING.popularLookbackDays * 24 * 60 * 60 * 1000;
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
              { OR: [{ boostScoreUpdatedAt: null }, { boostScoreUpdatedAt: { lt: staleBefore } }] },
            ],
          },
          orderBy: [{ boostCount: 'desc' }, { createdAt: 'desc' }, { id: 'desc' }],
          take: POSTS_RANKING.popularWarmupTake,
          select: { id: true },
        });
        await this.ranking.ensureBoostScoresFresh(warmup.map((p) => p.id));
      }

      const snapshotAsOf = decoded ? asOf : new Date();
      const snapshotMinCreatedAt = new Date(snapshotAsOf.getTime() - lookbackMs);

      const cursorCreatedAt = decoded ? new Date(decoded.createdAt) : null;
      const cursorScore = decoded?.score ?? null;
      const cursorId = decoded?.id ?? null;

      const rows = await this.prisma.$queryRaw<Array<{ id: string; createdAt: Date; score: number }>>(Prisma.sql`
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
                CASE
                WHEN p."boostScore" IS NULL OR p."boostScoreUpdatedAt" IS NULL THEN 0
                ELSE p."boostScore" * POWER(
                  0.5,
                  GREATEST(
                    0,
                    EXTRACT(EPOCH FROM (${snapshotAsOf}::timestamptz - p."createdAt"))
                  ) / ${POSTS_RANKING.popularHalfLifeSeconds}
                )
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
                      ELSE p."boostScore" * POWER(0.5, GREATEST(0, EXTRACT(EPOCH FROM (${snapshotAsOf}::timestamptz - p."createdAt")) / ${POSTS_RANKING.popularHalfLifeSeconds})) END
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
            AND p."communityGroupId" IS NULL
            ${params.topLevelOnly ? Prisma.sql`AND p."parentId" IS NULL` : Prisma.sql``}
            AND p."kind"::text <> 'repost'
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
      const nextRow = rows.length > limit ? sliceRows[sliceRows.length - 1] ?? null : null;

      const posts = ids.length
        ? await this.prisma.post.findMany({
            where: { id: { in: ids } },
            include: feedPostInclude,
          })
        : [];
      const byId = new Map(posts.map((p) => [p.id, p] as const));
      const ordered = ids.map((id) => byId.get(id)).filter((p): p is (typeof posts)[number] => Boolean(p));

      const nextCursor =
        rows.length > limit && nextRow
          ? this.encodePopularCursor({
              score: nextRow.score,
              createdAt: nextRow.createdAt.toISOString(),
              id: nextRow.id,
            })
          : null;

      const scoreByPostId = new Map<string, number>(sliceRows.map((r) => [r.id, r.score]));
      return { posts: ordered, nextCursor, counts, scoreByPostId };
    }

    const cursorWhere = await createdAtIdCursorWhere({
      cursor,
      lookup: async (id) => await this.prisma.post.findUnique({ where: { id }, select: { id: true, createdAt: true } }),
    });

    const posts = await this.prisma.post.findMany({
      where: { AND: [baseWhere, ...(cursorWhere ? [cursorWhere] : [])] },
      include: feedPostInclude,
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      take: limit + 1,
    });

    const slice = posts.slice(0, limit);
    const nextCursor = posts.length > limit ? slice[slice.length - 1]?.id ?? null : null;

    return { posts: slice, nextCursor, counts };
  }

  private encodeCommentCursor(cursor: { createdAt: string; id: string }) {
    return Buffer.from(JSON.stringify(cursor), 'utf8').toString('base64url');
  }

  private decodeCommentCursor(
    token: string | null,
  ): { createdAt: string; id: string } | null {
    const t = (token ?? '').trim();
    if (!t) return null;
    try {
      const raw = Buffer.from(t, 'base64url').toString('utf8');
      const parsed = JSON.parse(raw) as Partial<{ createdAt: string; id: string }>;
      const createdAt = typeof parsed.createdAt === 'string' ? parsed.createdAt : '';
      const id = typeof parsed.id === 'string' ? parsed.id : '';
      if (!createdAt || !id) return null;
      return { createdAt, id };
    } catch {
      return null;
    }
  }

  /**
   * List comments for a post. Viewer must be able to see the parent (same rule as getById).
   * Only top-level posts can have comments; only-me parents are unreachable.
   */
  async listComments(params: {
    viewerUserId: string | null;
    postId: string;
    limit: number;
    cursor: string | null;
    visibility?: 'all' | PostVisibility;
    sort?: 'new' | 'popular';
  }) {
    const { viewerUserId, postId, limit, cursor, visibility = 'all', sort = 'new' } = params;
    const parent = await this.getById({ viewerUserId, id: postId });
    if (parent.visibility === 'onlyMe') {
      throw new ForbiddenException('This post is private.');
    }

    const viewer = await this.viewerContextService.getViewer(viewerUserId);
    const allowed = this.enrichment.allowedVisibilitiesForViewer(viewer);
    const baseVisibilityWhere: Prisma.PostWhereInput =
      visibility === 'all'
        ? { visibility: { in: allowed } }
        : visibility === 'public'
          ? { visibility: 'public' }
          : { visibility };
    // Author always sees own replies (e.g. after tier downgrade).
    const visibilityWhere: Prisma.PostWhereInput =
      viewerUserId
        ? { OR: [baseVisibilityWhere, { userId: viewerUserId }] }
        : baseVisibilityWhere;

    const decoded = this.decodeCommentCursor(cursor);
    const isDesc = sort === 'new';
    const cursorWhere =
      decoded != null
        ? isDesc
          ? ({
              OR: [
                { createdAt: { lt: new Date(decoded.createdAt) } },
                { AND: [{ createdAt: new Date(decoded.createdAt) }, { id: { lt: decoded.id } }] },
              ],
            } as Prisma.PostWhereInput)
          : ({
              OR: [
                { createdAt: { gt: new Date(decoded.createdAt) } },
                { AND: [{ createdAt: new Date(decoded.createdAt) }, { id: { gt: decoded.id } }] },
              ],
            } as Prisma.PostWhereInput)
        : undefined;

    const baseWhere = {
      parentId: postId,
      ...visibilityWhere,
      ...notDeletedWhere(),
    };

    if (sort === 'popular') {
      const candidateIds = (
        await this.prisma.post.findMany({
          where: { ...baseWhere, OR: [{ boostCount: { gt: 0 } }, { bookmarkCount: { gt: 0 } }] },
          select: { id: true },
          take: 500,
        })
      ).map((p) => p.id);
      if (candidateIds.length > 0) await this.ranking.ensureBoostScoresFresh(candidateIds);
      const comments = await this.prisma.post.findMany({
        where: cursorWhere ? { AND: [baseWhere, cursorWhere] } : baseWhere,
        include: {
          user: { select: USER_LIST_SELECT },
          media: { orderBy: { position: 'asc' } },
          mentions: { include: { user: { select: MENTION_USER_SELECT } } },
        },
        orderBy: [
          { boostScore: 'desc' },
          { boostCount: 'desc' },
          { createdAt: 'desc' },
          { id: 'desc' },
        ],
        take: limit + 1,
      });
      const slice = comments.slice(0, limit);
      const nextCursor =
        comments.length > limit && slice[slice.length - 1]
          ? this.encodeCommentCursor({
              createdAt: slice[slice.length - 1].createdAt.toISOString(),
              id: slice[slice.length - 1].id,
            })
          : null;
      const countsWhere =
        viewerUserId
          ? { parentId: postId, ...notDeletedWhere(), OR: [{ visibility: { in: allowed } }, { userId: viewerUserId }] }
          : { parentId: postId, ...notDeletedWhere(), visibility: { in: allowed } };
      const counts = await this.prisma.post.groupBy({
        by: ['visibility'],
        where: countsWhere,
        _count: { _all: true },
      });
      const countMap = { all: 0, public: 0, verifiedOnly: 0, premiumOnly: 0 };
      for (const g of counts) {
        countMap.all += g._count._all;
        if (g.visibility === 'public') countMap.public = g._count._all;
        if (g.visibility === 'verifiedOnly') countMap.verifiedOnly = g._count._all;
        if (g.visibility === 'premiumOnly') countMap.premiumOnly = g._count._all;
      }
      return { comments: slice, nextCursor, counts: countMap };
    }

    const comments = await this.prisma.post.findMany({
      where: cursorWhere ? { AND: [baseWhere, cursorWhere] } : baseWhere,
      include: {
        user: { select: USER_LIST_SELECT },
        media: { orderBy: { position: 'asc' } },
        mentions: { include: { user: { select: MENTION_USER_SELECT } } },
      },
      orderBy: isDesc ? [{ createdAt: 'desc' }, { id: 'desc' }] : [{ createdAt: 'asc' }, { id: 'asc' }],
      take: limit + 1,
    });

    const slice = comments.slice(0, limit);
    const nextCursor =
      comments.length > limit && slice[slice.length - 1]
        ? this.encodeCommentCursor({
            createdAt: slice[slice.length - 1].createdAt.toISOString(),
            id: slice[slice.length - 1].id,
          })
        : null;

    const countsWhereNonPopular =
      viewerUserId
        ? { parentId: postId, ...notDeletedWhere(), OR: [{ visibility: { in: allowed } }, { userId: viewerUserId }] }
        : { parentId: postId, ...notDeletedWhere(), visibility: { in: allowed } };
    const counts = await this.prisma.post.groupBy({
      by: ['visibility'],
      where: countsWhereNonPopular,
      _count: { _all: true },
    });
    const countMap = { all: 0, public: 0, verifiedOnly: 0, premiumOnly: 0 };
    for (const g of counts) {
      countMap.all += g._count._all;
      if (g.visibility === 'public') countMap.public = g._count._all;
      if (g.visibility === 'verifiedOnly') countMap.verifiedOnly = g._count._all;
      if (g.visibility === 'premiumOnly') countMap.premiumOnly = g._count._all;
    }

    return { comments: slice, nextCursor, counts: countMap };
  }

  /**
   * Thread participants = root post author + all comment authors + everyone mentioned in the thread.
   * Used to pre-fill mentions and show "Replying to @userA, @userB" when composing a reply.
   */
  async getThreadParticipants(params: { viewerUserId: string | null; postId: string }) {
    const { viewerUserId, postId } = params;
    const post = await this.getById({ viewerUserId, id: postId });
    if (post.visibility === 'onlyMe') {
      throw new ForbiddenException('This post is private.');
    }

    // Use rootId if set (post is a reply), otherwise post.id is the root
    const rootId = (post as { rootId?: string | null }).rootId ?? post.id;

    // Collect all posts in the thread: root post + all replies (using rootId index)
    const threadPosts = await this.prisma.post.findMany({
      where: { OR: [{ id: rootId }, { rootId }], ...notDeletedWhere() },
      select: { userId: true, mentions: { select: { userId: true } } },
    });
    const participantIds = new Set<string>();
    for (const p of threadPosts) {
      participantIds.add(p.userId);
      for (const m of p.mentions) participantIds.add(m.userId);
    }

    const users = await this.prisma.user.findMany({
      where: { id: { in: Array.from(participantIds) }, usernameIsSet: true, bannedAt: null },
      select: { id: true, username: true },
    });
    return {
      participants: users
        .filter((u) => u.username != null)
        .map((u) => ({ id: u.id, username: u.username as string })),
    };
  }

  async getById(params: { viewerUserId: string | null; id: string }) {
    const { viewerUserId, id } = params;
    const postId = (id ?? '').trim();
    if (!postId) throw new NotFoundException('Post not found.');

    const cacheKey = `posts.getById:${viewerUserId ?? 'anon'}:${postId}`;
    const cached = this.requestCache.get<FeedPost>(cacheKey);
    if (cached) return cached;

    const viewer = await this.viewerContextService.getViewer(viewerUserId);
    const allowed = this.enrichment.allowedVisibilitiesForViewer(viewer);

    const post = await this.prisma.post.findFirst({
      where: { id: postId, ...(viewer?.siteAdmin ? {} : notDeletedWhere()) },
      include: {
        user: { select: USER_LIST_SELECT },
        media: { orderBy: { position: 'asc' } },
        poll: { include: { options: { orderBy: { position: 'asc' } } } },
        mentions: { include: { user: { select: MENTION_USER_SELECT } } },
        quotedPost: { include: QUOTED_POST_INCLUDE },
      },
    });
    if (!post) throw new NotFoundException('Post not found.');

    const gid = (post as { communityGroupId?: string | null }).communityGroupId ?? null;

    // Author can always view their own posts.
    const isSelf = Boolean(viewer && viewer.id === post.userId);
    let knownActiveGroupMember = false;
    if (!isSelf && gid && viewerUserId && !viewer?.siteAdmin) {
      const m = await this.prisma.communityGroupMember.findUnique({
        where: { groupId_userId: { groupId: gid, userId: viewerUserId } },
        select: { status: true },
      });
      knownActiveGroupMember = m?.status === 'active';
    }

    if (!isSelf) {
      // Only-me posts are private. Allow site admins to view for support/moderation.
      if (post.visibility === 'onlyMe' && !viewer?.siteAdmin) throw new ForbiddenException('This post is private.');
      const visibilityOk = allowed.includes(post.visibility);
      if (!visibilityOk) {
        if (post.visibility === 'verifiedOnly') throw new ForbiddenException('Verify to view verified-only posts.');
        if (post.visibility === 'premiumOnly') throw new ForbiddenException('Upgrade to premium to view premium-only posts.');
        throw new ForbiddenException('Not allowed to view this post.');
      }
    }

    await this.assertReadableCommunityGroupPost(
      {
        userId: post.userId,
        communityGroupId: gid,
      },
      viewerUserId,
      viewer,
      knownActiveGroupMember ? { knownActiveMember: true } : undefined,
    );

    this.requestCache.set(cacheKey, post as FeedPost);
    return post;
  }

  /**
   * Batch variant of getById used by feed controllers to reduce per-id round trips.
   * Applies the same visibility rules as getById and omits inaccessible/missing ids.
   */
  async getByIds(params: { viewerUserId: string | null; ids: string[] }): Promise<FeedPost[]> {
    const viewerUserId = params.viewerUserId ?? null;
    const ids = [...new Set((params.ids ?? []).map((id) => (id ?? '').trim()).filter(Boolean))];
    if (!ids.length) return [];

    const viewer = await this.viewerContextService.getViewer(viewerUserId);
    const allowed = this.enrichment.allowedVisibilitiesForViewer(viewer);

    const cached: FeedPost[] = [];
    const missingIds: string[] = [];
    for (const id of ids) {
      const cacheKey = `posts.getById:${viewerUserId ?? 'anon'}:${id}`;
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
          include: {
            user: { select: USER_LIST_SELECT },
            media: { orderBy: { position: 'asc' } },
            poll: { include: { options: { orderBy: { position: 'asc' } } } },
            mentions: { include: { user: { select: MENTION_USER_SELECT } } },
            article: ARTICLE_SHARE_INCLUDE,
            quotedPost: { include: QUOTED_POST_INCLUDE },
          },
        })
      : [];

    const groupIdsForVis = [
      ...new Set(
        fetched
          .map((p) => (p as { communityGroupId?: string | null }).communityGroupId)
          .filter((x): x is string => Boolean(x)),
      ),
    ];
    let memberGroupIdsForVis = new Set<string>();
    if (viewerUserId && groupIdsForVis.length > 0) {
      const memRows = await this.prisma.communityGroupMember.findMany({
        where: { userId: viewerUserId, groupId: { in: groupIdsForVis }, status: 'active' },
        select: { groupId: true },
      });
      memberGroupIdsForVis = new Set(memRows.map((r) => r.groupId));
    }

    const visibleFetched = fetched.filter((post) => {
      const isSelf = Boolean(viewer && viewer.id === post.userId);
      if (isSelf) return true;
      if (post.visibility === 'onlyMe') return Boolean(viewer?.siteAdmin);
      const pg = (post as { communityGroupId?: string | null }).communityGroupId ?? null;
      if (pg && memberGroupIdsForVis.has(pg)) return true;
      return allowed.includes(post.visibility);
    });

    const visibleFetchedGroupScoped = await this.filterPostsByCommunityGroupAccess({
      viewerUserId,
      viewer,
      posts: visibleFetched,
    });

    for (const post of visibleFetchedGroupScoped) {
      const cacheKey = `posts.getById:${viewerUserId ?? 'anon'}:${post.id}`;
      this.requestCache.set(cacheKey, post as FeedPost);
    }

    const byId = new Map<string, FeedPost>([
      ...cached.map((p) => [p.id, p] as const),
      ...visibleFetchedGroupScoped.map((p) => [p.id, p as FeedPost] as const),
    ]);
    return ids.map((id) => byId.get(id)).filter((p): p is FeedPost => Boolean(p));
  }

  /**
   * Like getById but for permalink preview: returns the post even when the viewer's tier
   * can't access it (verifiedOnly / premiumOnly). onlyMe posts still throw 404.
   * The caller is responsible for passing `viewerCanAccess: false` to toPostDto.
   */
  async getByIdNoAccess(id: string): Promise<FeedPost> {
    const postId = (id ?? '').trim();
    if (!postId) throw new NotFoundException('Post not found.');

    const post = await this.prisma.post.findFirst({
      where: { id: postId, visibility: { not: 'onlyMe' }, deletedAt: null },
      include: {
        user: { select: USER_LIST_SELECT },
        media: { orderBy: { position: 'asc' } },
        poll: { include: { options: { orderBy: { position: 'asc' } } } },
        mentions: { include: { user: { select: MENTION_USER_SELECT } } },
        quotedPost: { include: QUOTED_POST_INCLUDE },
      },
    });
    if (!post) throw new NotFoundException('Post not found.');
    return post as FeedPost;
  }

  async listMediaForUsername(params: {
    viewerUserId: string | null;
    username: string;
    limit: number;
    cursor: string | null;
    visibility: 'all' | PostVisibility;
    sort: 'new' | 'trending';
    includeRestricted?: boolean;
  }) {
    const { viewerUserId, username, limit, cursor, visibility, sort, includeRestricted } = params;
    const normalized = (username ?? '').trim();
    if (!normalized) throw new NotFoundException('User not found.');

    const user = await this.prisma.user.findFirst({
      where: { username: { equals: normalized, mode: 'insensitive' } },
      select: { id: true },
    });
    if (!user) throw new NotFoundException('User not found.');

    const viewer = await this.viewerContextService.getViewer(viewerUserId);
    const isSelf = Boolean(viewer && viewer.id === user.id);
    const allowed = isSelf
      ? (['public', 'verifiedOnly', 'premiumOnly'] as PostVisibility[])
      : this.enrichment.allowedVisibilitiesForViewer(viewer);

    // When includeRestricted, fetch all tiers and compute access per item.
    // When a specific visibility is requested via filter, honour it even in restricted mode.
    const allVisibilities: PostVisibility[] = ['public', 'verifiedOnly', 'premiumOnly'];
    const visibilityFilter: PostVisibility[] = includeRestricted
      ? (visibility !== 'all' ? [visibility as PostVisibility] : allVisibilities)
      : (visibility === 'all'
          ? allowed
          : allowed.includes(visibility as PostVisibility)
            ? [visibility as PostVisibility]
            : []);

    const r2BaseUrl = this.appConfig.r2()?.publicBaseUrl ?? null;

    // Trending sort: join through post.trendingScore. Use numeric offset cursor
    // (encoded as base64) because score order is volatile and ID-lt breaks pages.
    const offset = sort === 'trending' && cursor ? (() => {
      try { return parseInt(Buffer.from(cursor, 'base64').toString('utf8'), 10) || 0; } catch { return 0; }
    })() : 0;

    const baseWhere: Prisma.PostMediaWhereInput = {
      kind: { in: ['image', 'video'] },
      source: 'upload',
      deletedAt: null,
      post: {
        userId: user.id,
        deletedAt: null,
        communityGroupId: null,
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

    if (sort === 'trending') {
      // Include all media (including zero/unscored posts), but rank by parent post score.
      // Unscored/null scores sort to the bottom so "trending" remains score-first.
      mediaRows = await this.prisma.postMedia.findMany({
        where: baseWhere,
        orderBy: [
          { post: { trendingScore: { sort: 'desc', nulls: 'last' } } },
          { post: { boostCount: 'desc' } },
          { post: { bookmarkCount: 'desc' } },
          { post: { repostCount: 'desc' } },
          { post: { commentCount: 'desc' } },
          { post: { createdAt: 'desc' } },
          { id: 'desc' },
        ],
        skip: offset,
        take: limit + 1,
        select: { id: true, kind: true, r2Key: true, thumbnailR2Key: true, width: true, height: true, durationSeconds: true, postId: true, post: { select: { visibility: true } } },
      });
    } else {
      mediaRows = await this.prisma.postMedia.findMany({
        where: { ...baseWhere, ...(cursor ? { id: { lt: cursor } } : {}) },
        orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
        take: limit + 1,
        select: { id: true, kind: true, r2Key: true, thumbnailR2Key: true, width: true, height: true, durationSeconds: true, postId: true, post: { select: { visibility: true } } },
      });
    }

    const hasMore = mediaRows.length > limit;
    const items = hasMore ? mediaRows.slice(0, limit) : mediaRows;

    let nextCursor: string | null = null;
    if (hasMore) {
      if (sort === 'trending') {
        nextCursor = Buffer.from(String(offset + limit)).toString('base64');
      } else {
        nextCursor = items[items.length - 1]?.id ?? null;
      }
    }

    return {
      items: items.map((m) => {
        const vis = m.post.visibility as PostVisibility;
        const viewerCanAccess = includeRestricted
          ? (isSelf || allowed.includes(vis))
          : true;
        return {
          id: m.id,
          postId: m.postId,
          kind: m.kind as 'image' | 'video',
          url: r2BaseUrl && m.r2Key ? `${r2BaseUrl}/${m.r2Key}` : null,
          thumbnailUrl: r2BaseUrl && m.thumbnailR2Key ? `${r2BaseUrl}/${m.thumbnailR2Key}` : null,
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
    sort: 'new' | 'trending';
  }) {
    const { viewerUserId, limit, cursor, sort } = params;
    const groupIds = await this.listActiveCommunityGroupIdsForUser(viewerUserId);
    if (!groupIds.length) return { items: [], nextCursor: null };

    const r2BaseUrl = this.appConfig.r2()?.publicBaseUrl ?? null;

    const viewer = await this.viewerContextService.getViewer(viewerUserId);
    const allowedVisibilities = this.enrichment.allowedVisibilitiesForViewer(viewer);

    const baseWhere: Prisma.PostMediaWhereInput = {
      kind: { in: ['image', 'video'] },
      source: 'upload',
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
      sort === 'trending' && cursor
        ? (() => {
            try {
              return parseInt(Buffer.from(cursor, 'base64').toString('utf8'), 10) || 0;
            } catch {
              return 0;
            }
          })()
        : 0;

    if (sort === 'trending') {
      mediaRows = await this.prisma.postMedia.findMany({
        where: baseWhere,
        orderBy: [
          { post: { trendingScore: { sort: 'desc', nulls: 'last' } } },
          { post: { boostCount: 'desc' } },
          { post: { bookmarkCount: 'desc' } },
          { post: { repostCount: 'desc' } },
          { post: { commentCount: 'desc' } },
          { post: { createdAt: 'desc' } },
          { id: 'desc' },
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
        orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
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
      if (sort === 'trending') {
        nextCursor = Buffer.from(String(offset + limit)).toString('base64');
      } else {
        nextCursor = items[items.length - 1]?.id ?? null;
      }
    }

    return {
      items: items.map((m) => ({
        id: m.id,
        postId: m.postId,
        kind: m.kind as 'image' | 'video',
        url: r2BaseUrl && m.r2Key ? `${r2BaseUrl}/${m.r2Key}` : null,
        thumbnailUrl: r2BaseUrl && m.thumbnailR2Key ? `${r2BaseUrl}/${m.thumbnailR2Key}` : null,
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
    sort: 'new' | 'trending';
  }) {
    const { viewerUserId, groupId, limit, cursor, sort } = params;
    await this.assertCanReadCommunityGroup(viewerUserId, groupId);

    const r2BaseUrl = this.appConfig.r2()?.publicBaseUrl ?? null;

    const baseWhere: Prisma.PostMediaWhereInput = {
      kind: { in: ['image', 'video'] },
      source: 'upload',
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
      sort === 'trending' && cursor
        ? (() => {
            try {
              return parseInt(Buffer.from(cursor, 'base64').toString('utf8'), 10) || 0;
            } catch {
              return 0;
            }
          })()
        : 0;

    if (sort === 'trending') {
      mediaRows = await this.prisma.postMedia.findMany({
        where: baseWhere,
        orderBy: [
          { post: { trendingScore: { sort: 'desc', nulls: 'last' } } },
          { post: { boostCount: 'desc' } },
          { post: { bookmarkCount: 'desc' } },
          { post: { repostCount: 'desc' } },
          { post: { commentCount: 'desc' } },
          { post: { createdAt: 'desc' } },
          { id: 'desc' },
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
        orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
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
      if (sort === 'trending') {
        nextCursor = Buffer.from(String(offset + limit)).toString('base64');
      } else {
        nextCursor = items[items.length - 1]?.id ?? null;
      }
    }

    return {
      items: items.map((m) => ({
        id: m.id,
        postId: m.postId,
        kind: m.kind as 'image' | 'video',
        url: r2BaseUrl && m.r2Key ? `${r2BaseUrl}/${m.r2Key}` : null,
        thumbnailUrl: r2BaseUrl && m.thumbnailR2Key ? `${r2BaseUrl}/${m.thumbnailR2Key}` : null,
        width: m.width,
        height: m.height,
        durationSeconds: m.durationSeconds ?? null,
      })),
      nextCursor,
    };
  }
}
