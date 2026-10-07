import { Injectable, Optional } from "@nestjs/common";
import { MutesService } from "../mutes/mutes.service";
import { PrismaService } from "../prisma/prisma.service";
import { RequestCacheService } from "../../common/cache/request-cache.service";
import { ViewerContextService } from "../viewer/viewer-context.service";
import { AppConfigService } from "../app/app-config.service";
import { PostsRankingService } from "./posts-ranking.service";
import { PostsViewerEnrichmentService } from "./posts-viewer-enrichment.service";
import { CommunityGroupReadAccessService } from "../viewer/community-group-read-access.service";
import { CacheService } from "../redis/cache.service";
import { CacheInvalidationService } from "../redis/cache-invalidation.service";
import { ConversationsService } from "./conversations.service";
import { PostsFeedAccessService } from "./posts-feed-access.service";
import { PostsFeedListingsService } from "./posts-feed-listings.service";
import { PostsFeedForYouService } from "./posts-feed-for-you.service";
import { PostsFeedPopularService } from "./posts-feed-popular.service";
import { PostsFeedFeaturedService } from "./posts-feed-featured.service";
import { PostsFeedLookupService } from "./posts-feed-lookup.service";
import { PostsFeedMediaService } from "./posts-feed-media.service";

/**
 * Thin facade over post read paths. Callers and tests keep depending on this
 * class; implementations live in focused providers registered beside it.
 */
@Injectable()
export class PostsFeedQueryService {
  private readonly access: PostsFeedAccessService;
  private readonly listings: PostsFeedListingsService;
  private readonly forYou: PostsFeedForYouService;
  private readonly popular: PostsFeedPopularService;
  private readonly featured: PostsFeedFeaturedService;
  private readonly lookup: PostsFeedLookupService;
  private readonly media: PostsFeedMediaService;

  constructor(
    private readonly prisma: PrismaService,
    private readonly requestCache: RequestCacheService,
    private readonly viewerContextService: ViewerContextService,
    private readonly appConfig: AppConfigService,
    private readonly enrichment: PostsViewerEnrichmentService,
    private readonly ranking: PostsRankingService,
    private readonly groupReadAccess: CommunityGroupReadAccessService,
    private readonly cache: CacheService,
    private readonly cacheInvalidation: CacheInvalidationService,
    private readonly conversations: ConversationsService = undefined!,
    @Optional() private readonly mutes?: MutesService,
    @Optional() access?: PostsFeedAccessService,
    @Optional() listings?: PostsFeedListingsService,
    @Optional() forYou?: PostsFeedForYouService,
    @Optional() popular?: PostsFeedPopularService,
    @Optional() featured?: PostsFeedFeaturedService,
    @Optional() lookup?: PostsFeedLookupService,
    @Optional() media?: PostsFeedMediaService,
  ) {
    this.access =
      access ??
      new PostsFeedAccessService(
        prisma,
        requestCache,
        viewerContextService,
        enrichment,
        cache,
        mutes,
      );
    this.listings =
      listings ??
      new PostsFeedListingsService(
        prisma,
        requestCache,
        viewerContextService,
        appConfig,
        enrichment,
        ranking,
        groupReadAccess,
        this.access,
        conversations,
      );
    this.popular =
      popular ??
      new PostsFeedPopularService(
        prisma,
        viewerContextService,
        enrichment,
        this.access,
        ranking,
      );
    this.featured =
      featured ??
      new PostsFeedFeaturedService(
        prisma,
        viewerContextService,
        enrichment,
        this.access,
        this.popular,
      );
    this.forYou =
      forYou ??
      new PostsFeedForYouService(
        prisma,
        viewerContextService,
        enrichment,
        cache,
        cacheInvalidation,
        this.access,
        conversations,
      );
    this.lookup =
      lookup ??
      new PostsFeedLookupService(
        prisma,
        requestCache,
        viewerContextService,
        enrichment,
        cache,
        this.access,
        ranking,
        appConfig,
      );
    this.media =
      media ??
      new PostsFeedMediaService(
        prisma,
        viewerContextService,
        enrichment,
        this.access,
        ranking,
        appConfig,
        this.listings,
      );
  }

  requireReadablePostShell(
    ...args: Parameters<PostsFeedAccessService["requireReadablePostShell"]>
  ) {
    return this.access.requireReadablePostShell(...args);
  }

  listOnlyMe(...args: Parameters<PostsFeedListingsService["listOnlyMe"]>) {
    return this.listings.listOnlyMe(...args);
  }

  listFeed(...args: Parameters<PostsFeedListingsService["listFeed"]>) {
    return this.listings.listFeed(...args);
  }

  listActiveCommunityGroupIdsForUser(
    ...args: Parameters<
      PostsFeedListingsService["listActiveCommunityGroupIdsForUser"]
    >
  ) {
    return this.listings.listActiveCommunityGroupIdsForUser(...args);
  }

  assertCanReadCommunityGroup(
    ...args: Parameters<PostsFeedListingsService["assertCanReadCommunityGroup"]>
  ) {
    return this.listings.assertCanReadCommunityGroup(...args);
  }

  listCommunityGroupsTimelinePosts(
    ...args: Parameters<
      PostsFeedListingsService["listCommunityGroupsTimelinePosts"]
    >
  ) {
    return this.listings.listCommunityGroupsTimelinePosts(...args);
  }

  collectParentMapForFeed(
    ...args: Parameters<PostsFeedListingsService["collectParentMapForFeed"]>
  ) {
    return this.listings.collectParentMapForFeed(...args);
  }

  collectRepostedMapForFeed(
    ...args: Parameters<PostsFeedListingsService["collectRepostedMapForFeed"]>
  ) {
    return this.listings.collectRepostedMapForFeed(...args);
  }

  communityGroupPreviewMapForFeed(
    ...args: Parameters<
      PostsFeedListingsService["communityGroupPreviewMapForFeed"]
    >
  ) {
    return this.listings.communityGroupPreviewMapForFeed(...args);
  }

  composeFeedPostDtos(
    ...args: Parameters<PostsFeedListingsService["composeFeedPostDtos"]>
  ) {
    return this.listings.composeFeedPostDtos(...args);
  }

  listComposedGroupScopedFeed(
    ...args: Parameters<PostsFeedListingsService["listComposedGroupScopedFeed"]>
  ) {
    return this.listings.listComposedGroupScopedFeed(...args);
  }

  communityGroupPreviewForGroup(
    ...args: Parameters<
      PostsFeedListingsService["communityGroupPreviewForGroup"]
    >
  ) {
    return this.listings.communityGroupPreviewForGroup(...args);
  }

  listForYouFeed(...args: Parameters<PostsFeedForYouService["listForYouFeed"]>) {
    return this.forYou.listForYouFeed(...args);
  }

  listPopularFeed(
    ...args: Parameters<PostsFeedPopularService["listPopularFeed"]>
  ) {
    return this.popular.listPopularFeed(...args);
  }

  listFeaturedFeed(
    ...args: Parameters<PostsFeedFeaturedService["listFeaturedFeed"]>
  ) {
    return this.featured.listFeaturedFeed(...args);
  }

  listForUsername(
    ...args: Parameters<PostsFeedMediaService["listForUsername"]>
  ) {
    return this.media.listForUsername(...args);
  }

  listReposters(...args: Parameters<PostsFeedMediaService["listReposters"]>) {
    return this.media.listReposters(...args);
  }

  listQuotes(...args: Parameters<PostsFeedMediaService["listQuotes"]>) {
    return this.media.listQuotes(...args);
  }

  listComments(...args: Parameters<PostsFeedLookupService["listComments"]>) {
    return this.lookup.listComments(...args);
  }

  getThreadParticipants(
    ...args: Parameters<PostsFeedLookupService["getThreadParticipants"]>
  ) {
    return this.lookup.getThreadParticipants(...args);
  }

  getById(...args: Parameters<PostsFeedLookupService["getById"]>) {
    return this.lookup.getById(...args);
  }

  getLatestPublic(
    ...args: Parameters<PostsFeedListingsService["getLatestPublic"]>
  ) {
    return this.listings.getLatestPublic(...args);
  }

  getPublicById(
    ...args: Parameters<PostsFeedListingsService["getPublicById"]>
  ) {
    return this.listings.getPublicById(...args);
  }

  getByIds(...args: Parameters<PostsFeedListingsService["getByIds"]>) {
    return this.listings.getByIds(...args);
  }

  collectAncestorPostIds(
    ...args: Parameters<PostsFeedListingsService["collectAncestorPostIds"]>
  ) {
    return this.listings.collectAncestorPostIds(...args);
  }

  videoEmbedsForPosts(
    ...args: Parameters<PostsFeedListingsService["videoEmbedsForPosts"]>
  ) {
    return this.listings.videoEmbedsForPosts(...args);
  }

  getByIdNoAccess(
    ...args: Parameters<PostsFeedLookupService["getByIdNoAccess"]>
  ) {
    return this.lookup.getByIdNoAccess(...args);
  }

  listMediaForUsername(
    ...args: Parameters<PostsFeedMediaService["listMediaForUsername"]>
  ) {
    return this.media.listMediaForUsername(...args);
  }

  listMediaForGroupsHub(
    ...args: Parameters<PostsFeedMediaService["listMediaForGroupsHub"]>
  ) {
    return this.media.listMediaForGroupsHub(...args);
  }

  listMediaForCommunityGroup(
    ...args: Parameters<PostsFeedMediaService["listMediaForCommunityGroup"]>
  ) {
    return this.media.listMediaForCommunityGroup(...args);
  }
}
