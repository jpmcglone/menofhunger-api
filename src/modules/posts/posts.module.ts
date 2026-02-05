import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module';
import { NotificationsModule } from '../notifications/notifications.module';
import { PostsController } from './posts.controller';
import { PostsPopularScoreCron } from './posts-popular-score.cron';
import { PostsService } from './posts.service';

@Module({
  imports: [AuthModule, NotificationsModule],
  controllers: [PostsController],
  providers: [PostsService, PostsPopularScoreCron],
  exports: [PostsService],
})
export class PostsModule {}

