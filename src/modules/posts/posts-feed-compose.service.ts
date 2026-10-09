import { ConversationsService } from "./conversations.service";
import { Injectable } from "@nestjs/common";
import { PrismaService } from "../prisma/prisma.service";
import { RequestCacheService } from "../../common/cache/request-cache.service";
import { ViewerContextService } from "../viewer/viewer-context.service";
import { AppConfigService } from "../app/app-config.service";
import { toCommunityGroupPreviewDto } from "../../common/dto/community-group.dto";
import type { CommunityGroupPreviewDto } from "../../common/dto/community-group.dto";
import { collectAncestorPostIds } from "../../common/posts/collect-ancestor-post-ids";
import { loadPostVideoEmbeds } from "../../common/posts/post-video-embeds";
import { type FeedCollapsedItem } from "../../common/feed-collapse/collapse-by-root";
import { applyCollapsedThreadSummary } from "../../common/feed-collapse/collapsed-thread-summary";
import { toPostDto, type PostAuthorDto, type PostDto } from "../../common/dto/post.dto";
import { buildAttachParentChain, postChainInvolvesAuthor } from "./posts.utils";
import { feedPostInclude, type FeedPost } from "./posts-feed.types";
import { PostsViewerEnrichmentService } from "./posts-viewer-enrichment.service";
import { PostsRankingService } from "./posts-ranking.service";
import { PostsFeedAccessService } from "./posts-feed-access.service";
import { listActiveGroupIdsAmong, listGroupMembershipsForUser } from '../viewer/group-membership.queries';
import { NOT_DELETED } from '../../common/prisma/where';

/** Turns feed rows into viewer-specific DTOs: access-checked batch loads, parent/repost chains, group previews, and ranking/video overlays. */
@Injectable()
export class PostsFeedComposeService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly requestCache: RequestCacheService,
    private readonly viewerContextService: ViewerContextService,
    private readonly appConfig: AppConfigService,
    private readonly enrichment: PostsViewerEnrichmentService,
    private readonly ranking: PostsRankingService,
    private readonly access: PostsFeedAccessService,
    private readonly conversations: ConversationsService,
  ) {}

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
        where: { id: { in: uniq }, ...NOT_DELETED },
      }),
      viewerUserId
        ? listGroupMembershipsForUser(this.prisma, viewerUserId, uniq)
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
      memberGroupIdsForVis = await listActiveGroupIdsAmong(this.prisma, viewerUserId, groupIdsForVis);
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
