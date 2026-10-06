import { GroupChannelsModule } from '../group-channels/group-channels.module';
import { MessagesModule } from '../messages/messages.module';
import { ViewerContextModule } from '../viewer/viewer-context.module';
import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module';
import { PrismaModule } from '../prisma/prisma.module';
import { ReportsController } from './reports.controller';
import { ReportsService } from './reports.service';

@Module({
  imports: [AuthModule, PrismaModule, GroupChannelsModule, MessagesModule, ViewerContextModule],
  controllers: [ReportsController],
  providers: [ReportsService],
  exports: [ReportsService],
})
export class ReportsModule {}

