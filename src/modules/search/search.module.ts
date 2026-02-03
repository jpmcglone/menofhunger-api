import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module';
import { PostsModule } from '../posts/posts.module';
import { SearchController } from './search.controller';
import { SearchService } from './search.service';

@Module({
  imports: [AuthModule, PostsModule],
  controllers: [SearchController],
  providers: [SearchService],
})
export class SearchModule {}

