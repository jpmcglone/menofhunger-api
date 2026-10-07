import { Injectable, Optional } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { PresenceRealtimeService } from '../presence/presence-realtime.service';
import { ViewerContextService } from '../viewer/viewer-context.service';
import { AppConfigService } from '../app/app-config.service';
import { CacheInvalidationService } from '../redis/cache-invalidation.service';
import { TickerService } from '../cashtags/ticker.service';
import { PostViewsService } from '../post-views/post-views.service';
import { PosthogService } from '../../common/posthog/posthog.service';
import { PostsRankingService } from './posts-ranking.service';
import { PostsViewerEnrichmentService } from './posts-viewer-enrichment.service';
import { SiteConfigService } from '../site-config/site-config.service';
import { SideEffectsService } from '../side-effects/side-effects.service';
import { PostsTopicsClassifyService } from './posts-topics-classify.service';
import { PostsMutationSupportService } from './posts-mutation-support.service';
import { PostsMutationEditsService } from './posts-mutation-edits.service';
import { PostsMutationWriteService } from './posts-mutation-write.service';

export type { CreatePostParams } from './posts-mutation.types';

/**
 * Post write paths: create (with the full side-effect pipeline), update,
 * delete, publish-from-onlyMe. Reads stay in PostsFeedQueryService;
 * engagement mutations (boost/repost) live in PostsEngagementService.
 */
@Injectable()
export class PostsMutationService {
  private readonly support: PostsMutationSupportService;
  readonly edits: PostsMutationEditsService;
  readonly write: PostsMutationWriteService;

  constructor(
    private readonly prisma: PrismaService,
    private readonly presenceRealtime: PresenceRealtimeService,
    private readonly cacheInvalidation: CacheInvalidationService,
    private readonly appConfig: AppConfigService,
    private readonly postViews: PostViewsService,
    private readonly posthog: PosthogService,
    private readonly viewerContextService: ViewerContextService,
    private readonly enrichment: PostsViewerEnrichmentService,
    private readonly ranking: PostsRankingService,
    private readonly ticker: TickerService,
    private readonly siteConfig: SiteConfigService,
    private readonly sideEffects: SideEffectsService,
    private readonly topicsClassify: PostsTopicsClassifyService,
    @Optional() support?: PostsMutationSupportService,
    @Optional() edits?: PostsMutationEditsService,
    @Optional() write?: PostsMutationWriteService,
  ) {
    const args = [
      prisma,
      presenceRealtime,
      cacheInvalidation,
      appConfig,
      postViews,
      posthog,
      viewerContextService,
      enrichment,
      ranking,
      ticker,
      siteConfig,
      sideEffects,
      topicsClassify,
    ] as const;
    this.support = support ?? new PostsMutationSupportService(...args);
    this.edits = edits ?? new PostsMutationEditsService(...args, this.support);
    this.write = write ?? new PostsMutationWriteService(...args, this.support);
    this.edits.createPost = (params) => this.write.createPost(params);
  }

  deletePost(...args: Parameters<PostsMutationEditsService['deletePost']>) {
    return this.edits.deletePost(...args);
  }
  updatePost(...args: Parameters<PostsMutationEditsService['updatePost']>) {
    return this.edits.updatePost(...args);
  }
  publishFromOnlyMe(...args: Parameters<PostsMutationEditsService['publishFromOnlyMe']>) {
    return this.edits.publishFromOnlyMe(...args);
  }
  createPost(...args: Parameters<PostsMutationWriteService['createPost']>) {
    return this.write.createPost(...args);
  }
  createMarvReply(...args: Parameters<PostsMutationWriteService['createMarvReply']>) {
    return this.write.createMarvReply(...args);
  }
  visibilityRank(vis: string): number {
    return this.support.visibilityRank(vis);
  }
}
