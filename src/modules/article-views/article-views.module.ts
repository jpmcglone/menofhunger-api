import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module';
import { RealtimeModule } from '../realtime/realtime.module';
import { RedisModule } from '../redis/redis.module';
import { NotificationsModule } from '../notifications/notifications.module';
import { ArticleViewsController } from './article-views.controller';
import { ArticleViewsService } from './article-views.service';

@Module({
  imports: [AuthModule, RealtimeModule, RedisModule, NotificationsModule],
  controllers: [ArticleViewsController],
  providers: [ArticleViewsService],
  exports: [ArticleViewsService],
})
export class ArticleViewsModule {}
