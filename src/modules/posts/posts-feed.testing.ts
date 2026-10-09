import type { AppConfigService } from '../app';
import type { CacheInvalidationService, CacheService } from '../redis';
import type { MutesService } from '../mutes';
import type { PrismaService } from '../prisma';
import type { RequestCacheService } from '../../common/cache/request-cache.service';
import type { CommunityGroupReadAccessService, ViewerContextService } from '../viewer';
import type { ConversationsService } from './conversations.service';
import { PostsFeedAccessService } from './posts-feed-access.service';
import { PostsFeedComposeService } from './posts-feed-compose.service';
import { PostsFeedFeaturedService } from './posts-feed-featured.service';
import { PostsFeedForYouService } from './posts-feed-for-you.service';
import { PostsFeedListingsService } from './posts-feed-listings.service';
import { PostsFeedLookupService } from './posts-feed-lookup.service';
import { PostsFeedMediaService } from './posts-feed-media.service';
import { PostsFeedPopularService } from './posts-feed-popular.service';
import { PostsFeedProfileService } from './posts-feed-profile.service';
import type { PostsRankingService } from './posts-ranking.service';
import type { PostsViewerEnrichmentService } from './posts-viewer-enrichment.service';

export type PostsFeedServiceDeps = {
  prisma: PrismaService;
  requestCache: RequestCacheService;
  viewerContext: ViewerContextService;
  appConfig: AppConfigService;
  enrichment: PostsViewerEnrichmentService;
  ranking: PostsRankingService;
  groupReadAccess: CommunityGroupReadAccessService;
  cache: CacheService;
  cacheInvalidation: CacheInvalidationService;
  conversations: ConversationsService;
  mutes?: MutesService;
};

/** Wires the post read services by hand for unit tests (the module does this through DI). */
export function makePostsFeedServices(d: PostsFeedServiceDeps) {
  const access = new PostsFeedAccessService(d.prisma, d.requestCache, d.viewerContext, d.enrichment, d.cache, d.mutes);
  const compose = new PostsFeedComposeService(
    d.prisma, d.requestCache, d.viewerContext, d.appConfig, d.enrichment, d.ranking, access, d.conversations,
  );
  const listings = new PostsFeedListingsService(
    d.prisma, d.requestCache, d.viewerContext, d.appConfig, d.enrichment, d.ranking, d.groupReadAccess, access, compose,
  );
  const popular = new PostsFeedPopularService(d.prisma, d.viewerContext, d.enrichment, access, d.ranking);
  const featured = new PostsFeedFeaturedService(d.prisma, d.viewerContext, d.enrichment, access, popular);
  const forYou = new PostsFeedForYouService(
    d.prisma, d.viewerContext, d.enrichment, d.cache, d.cacheInvalidation, access, d.conversations,
  );
  const lookup = new PostsFeedLookupService(
    d.prisma, d.requestCache, d.viewerContext, d.enrichment, d.cache, access, d.ranking, d.appConfig,
  );
  const profile = new PostsFeedProfileService(d.prisma, d.viewerContext, d.enrichment, access, d.ranking);
  const media = new PostsFeedMediaService(d.prisma, d.viewerContext, d.enrichment, access, d.ranking, d.appConfig, listings);
  return { access, compose, listings, popular, featured, forYou, lookup, profile, media };
}
