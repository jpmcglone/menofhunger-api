import type { EmbeddingsService } from '../embeddings/embeddings.service';
import type { ArticlesRankingService } from '../articles/articles-ranking.service';
import type { TickerService } from '../cashtags/ticker.service';
import type { FollowsService } from '../follows/follows.service';
import type { PostsReadService } from '../posts-read/posts-read.service';
import type { PrismaService } from '../prisma/prisma.service';
import type { JevSearchIntentService } from '../typesafe/jev-search-intent.service';
import type { JevTopicsService } from '../typesafe/jev-topics.service';
import type { ViewerContextService } from '../viewer/viewer-context.service';
import { SearchContentService } from './search-content.service';
import { SearchPostsService } from './search-posts.service';
import { SearchScopeService } from './search-scope.service';
import type { SearchUsersService } from './search-users.service';
import { SearchService } from './search.service';

/** Wires SearchService and its collaborators by hand for unit tests (the module does this through DI). */
export function buildSearchService(
  prisma: PrismaService,
  postsRead: PostsReadService,
  follows: FollowsService,
  posts: ConstructorParameters<typeof SearchPostsService>[1],
  articlesRanking: ArticlesRankingService,
  viewerContext: ViewerContextService,
  ticker: TickerService,
  users: SearchUsersService,
  jevTopics?: JevTopicsService,
  embeddings?: EmbeddingsService,
  jevIntent?: JevSearchIntentService,
): SearchService {
  const scope = new SearchScopeService(prisma, viewerContext);
  return new SearchService(
    prisma, postsRead, viewerContext, follows, ticker, users,
    new SearchPostsService(scope, posts, postsRead, prisma, viewerContext, embeddings, jevIntent, jevTopics),
    new SearchContentService(scope, articlesRanking, prisma, viewerContext),
  );
}
