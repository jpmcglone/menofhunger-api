import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module';
import { FollowsModule } from '../follows/follows.module';
import { PostsModule } from '../posts/posts.module';
import { SearchController } from './search.controller';
import { SearchCleanupCron } from './search-cleanup.cron';
import { SearchService } from './search.service';

@Module({
  imports: [AuthModule, FollowsModule, PostsModule],
  controllers: [SearchController],
  providers: [SearchService, SearchCleanupCron],
  exports: [SearchService, SearchCleanupCron],
})
export class SearchModule {}

