import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module';
import { RealtimeModule } from '../realtime/realtime.module';
import { NotificationsModule } from '../notifications/notifications.module';
import { RedisModule } from '../redis/redis.module';
import { PostViewsController } from './post-views.controller';
import { PostViewsBatchService } from './post-views-batch.service';
import { PostViewsService } from './post-views.service';

@Module({
  imports: [AuthModule, RealtimeModule, RedisModule, NotificationsModule],
  controllers: [PostViewsController],
  providers: [PostViewsService, PostViewsBatchService],
  exports: [PostViewsService],
})
export class PostViewsModule {}
