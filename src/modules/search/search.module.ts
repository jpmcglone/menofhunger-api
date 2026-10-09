import { SearchUsersService } from './search-users.service';
import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module';
import { FollowsModule } from '../follows/follows.module';
import { PostsModule } from '../posts/posts.module';
import { ArticlesModule } from '../articles/articles.module';
import { TaxonomyModule } from '../taxonomy/taxonomy.module';
import { CashtagsModule } from '../cashtags/cashtags.module';
import { ArticleViewsModule } from '../article-views/article-views.module';
import { SearchController } from './search.controller';
import { SearchCleanupCron } from './search-cleanup.cron';
import { SearchScopeService } from './search-scope.service';
import { SearchPostsService } from './search-posts.service';
import { SearchContentService } from './search-content.service';
import { SearchService } from './search.service';
import { RecentSearchesService } from './recent-searches.service';

@Module({
  imports: [AuthModule, FollowsModule, PostsModule, ArticlesModule, TaxonomyModule, CashtagsModule, ArticleViewsModule],
  controllers: [SearchController],
  providers: [SearchUsersService, SearchScopeService, SearchPostsService, SearchContentService, SearchService, RecentSearchesService, SearchCleanupCron],
  exports: [SearchService, SearchCleanupCron],
})
export class SearchModule {}

