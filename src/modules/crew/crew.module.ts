import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module';
import { PrismaModule } from '../prisma/prisma.module';
import { RealtimeModule } from '../realtime/realtime.module';
import { NotificationsModule } from '../notifications/notifications.module';
import { MessagesModule } from '../messages/messages.module';
import { JobsModule } from '../jobs/jobs.module';
import { CrewController } from './crew.controller';
import { CrewService } from './crew.service';
import { CrewInvitesService } from './crew-invites.service';
import { CrewWallService } from './crew-wall.service';
import { CrewTransferService } from './crew-transfer.service';
import { CrewJobsCron } from './crew-jobs.cron';

@Module({
  imports: [
    AuthModule,
    PrismaModule,
    RealtimeModule,
    NotificationsModule,
    MessagesModule,
    JobsModule,
  ],
  controllers: [CrewController],
  providers: [
    CrewService,
    CrewInvitesService,
    CrewWallService,
    CrewTransferService,
    CrewJobsCron,
  ],
  exports: [
    CrewService,
    CrewInvitesService,
    CrewWallService,
    CrewTransferService,
    CrewJobsCron,
  ],
})
export class CrewModule {}
