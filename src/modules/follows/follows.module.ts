import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module';
import { NotificationsModule } from '../notifications/notifications.module';
import { RealtimeModule } from '../realtime/realtime.module';
import { FollowsController } from './follows.controller';
import { FollowsService } from './follows.service';
import { FollowRelationshipsService } from './follows-relationships.service';
import { FollowRecommendationsService } from './follows-recommendations.service';
import { FollowMeaningRecommendationsService } from './follows-meaning.service';
import { FollowNudgeService } from './follows-nudge.service';
import { FollowListsService } from './follows-lists.service';
import { FollowsSideEffectsHandler } from './follows-side-effects.handler';

@Module({
  imports: [AuthModule, NotificationsModule, RealtimeModule],
  controllers: [FollowsController],
  providers: [FollowRelationshipsService, FollowRecommendationsService, FollowMeaningRecommendationsService, FollowNudgeService, FollowListsService, FollowsService, FollowsSideEffectsHandler],
  exports: [FollowsService],
})
export class FollowsModule {}

