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
import { SearchService } from './search.service';

@Module({
  imports: [AuthModule, FollowsModule, PostsModule, ArticlesModule, TaxonomyModule, CashtagsModule, ArticleViewsModule],
  controllers: [SearchController],
  providers: [SearchService, SearchCleanupCron],
  exports: [SearchService, SearchCleanupCron],
})
export class SearchModule {}

