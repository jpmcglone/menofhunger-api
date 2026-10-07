import { Global, Module } from '@nestjs/common';
import { PostsReadService } from './posts-read.service';

@Global()
@Module({
  providers: [PostsReadService],
  exports: [PostsReadService],
})
export class PostsReadModule {}
