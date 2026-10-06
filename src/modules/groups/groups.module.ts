import { ChannelAccessModule } from '../group-channels/channel-access.module';
import { Module } from '@nestjs/common';
import { EmailModule } from '../email/email.module';
import { AuthModule } from '../auth/auth.module';
import { PostsModule } from '../posts/posts.module';
import { PrismaModule } from '../prisma/prisma.module';
import { NotificationsModule } from '../notifications/notifications.module';
import { RedisModule } from '../redis/redis.module';
import { RealtimeModule } from '../realtime/realtime.module';
import { GroupsController } from './groups.controller';
import { GroupsService } from './groups.service';
import { GroupInvitesService } from './group-invites.service';
import { GroupsSideEffectsHandler } from './groups-side-effects.handler';

@Module({
  imports: [ChannelAccessModule, 
    AuthModule,
    EmailModule,
    PrismaModule,
    PostsModule,
    NotificationsModule,
    RedisModule,
    RealtimeModule,
  ],
  controllers: [GroupsController],
  providers: [GroupsService, GroupInvitesService, GroupsSideEffectsHandler],
  exports: [GroupsService, GroupInvitesService],
})
export class GroupsModule {}
