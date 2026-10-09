import { ChannelAnalyticsService } from './channel-analytics.service';
import { ChannelMarvScopeService } from './channel-marv-scope.service';
import { NotificationsModule } from '../notifications/notifications.module';
import { ChannelNotificationsSideEffectsHandler } from './channel-notifications-side-effects.handler';
import { ChannelViewingService } from './channel-viewing.service';
import { EmailModule } from '../email/email.module';
import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module';
import { PrismaModule } from '../prisma/prisma.module';
import { RealtimeModule } from '../realtime/realtime.module';
import { ChannelMediaService } from './channel-media.service';
import { ChannelAccessModule } from './channel-access.module';
import { ChannelAttentionService } from './channel-attention.service';
import { ChannelMessageReadService } from './channel-message-read.service';
import { ChannelMessagesService } from './channel-messages.service';
import { ChannelsService } from './channels.service';
import { GroupChannelsController } from './group-channels.controller';

@Module({
  imports: [AuthModule, PrismaModule, RealtimeModule, ChannelAccessModule, NotificationsModule, EmailModule],
  controllers: [GroupChannelsController],
  providers: [ChannelAnalyticsService, ChannelMarvScopeService, ChannelNotificationsSideEffectsHandler, ChannelViewingService, ChannelMediaService, ChannelsService, ChannelAttentionService, ChannelMessageReadService, ChannelMessagesService],
  exports: [ChannelAccessModule, ChannelsService, ChannelMediaService, ChannelMarvScopeService, ChannelMessageReadService, ChannelMessagesService, ChannelAttentionService],
})
export class GroupChannelsModule {}
