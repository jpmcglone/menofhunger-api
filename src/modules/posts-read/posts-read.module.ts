import { Global, Module } from '@nestjs/common';
import { PostsReadService } from './posts-read.service';
import { PostsWriteService } from './posts-write.service';

@Global()
@Module({
  providers: [PostsReadService, PostsWriteService],
  exports: [PostsReadService, PostsWriteService],
})
export class PostsReadModule {}
