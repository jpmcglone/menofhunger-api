import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module';
import { PostsModule } from '../posts/posts.module';
import { SearchModule } from '../search/search.module';
import { TopicsController } from './topics.controller';
import { TopicsService } from './topics.service';

@Module({
  imports: [AuthModule, PostsModule, SearchModule],
  controllers: [TopicsController],
  providers: [TopicsService],
})
export class TopicsModule {}

