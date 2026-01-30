import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module';
import { SearchController } from './search.controller';
import { SearchService } from './search.service';
import { PostsService } from '../posts/posts.service';

@Module({
  imports: [AuthModule],
  controllers: [SearchController],
  providers: [SearchService, PostsService],
})
export class SearchModule {}

