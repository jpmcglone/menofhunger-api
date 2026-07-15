import { Module } from '@nestjs/common';
import { PostsModule } from '../posts/posts.module';
import { UsersModule } from '../users/users.module';
import { PublicController } from './public.controller';

@Module({
  imports: [PostsModule, UsersModule],
  controllers: [PublicController],
})
export class PublicModule {}
