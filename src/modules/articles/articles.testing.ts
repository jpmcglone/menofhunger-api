import type { AppConfigService } from '../app/app-config.service';
import type { ArticleViewsService } from '../article-views/article-views.service';
import type { BoardService } from '../board/board.service';
import type { JobsService } from '../jobs/jobs.service';
import type { PrismaService } from '../prisma/prisma.service';
import type { PostsSharedWriteService } from '../posts/posts-shared-write.service';
import type { PresenceRealtimeService } from '../presence/presence-realtime.service';
import type { CacheInvalidationService } from '../redis/cache-invalidation.service';
import type { CacheService } from '../redis/cache.service';
import type { SideEffectsService } from '../side-effects/side-effects.service';
import type { ViewerContextService } from '../viewer/viewer-context.service';
import { ArticleAccessService } from './article-access.service';
import { ArticleCommentWriterService } from './article-comment-writer.service';
import { ArticleCommentsService } from './article-comments.service';
import { ArticleDiscoveryService } from './article-discovery.service';
import { ArticleEngagementService } from './article-engagement.service';
import { ArticleFeedService } from './article-feed.service';
import { ArticlesService } from './articles.service';

/** Wires ArticlesService and its collaborators by hand for unit tests (the module does this through DI). */
export function makeArticlesService(
  prisma: PrismaService,
  viewer: ViewerContextService,
  appConfig: AppConfigService,
  presenceRealtime: PresenceRealtimeService,
  cache: CacheService,
  cacheInvalidation: CacheInvalidationService,
  jobs: JobsService,
  sideEffects: SideEffectsService,
  articleViews: ArticleViewsService,
  board: BoardService,
  postsWrite: PostsSharedWriteService,
): ArticlesService {
  const access = new ArticleAccessService(prisma, viewer);
  return new ArticlesService(
    prisma, viewer, appConfig, presenceRealtime, cache, cacheInvalidation, jobs, sideEffects, articleViews, board,
    new ArticleCommentsService(prisma, viewer, appConfig, presenceRealtime, board, access),
    new ArticleEngagementService(prisma, appConfig, presenceRealtime, sideEffects, postsWrite, access),
    new ArticleDiscoveryService(prisma, viewer, appConfig, articleViews),
    new ArticleFeedService(prisma, viewer, appConfig, articleViews),
    new ArticleCommentWriterService(prisma, viewer, appConfig, presenceRealtime, sideEffects, board, access),
  );
}
