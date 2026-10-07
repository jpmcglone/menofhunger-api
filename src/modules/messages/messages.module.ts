import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module';
import { RealtimeModule } from '../realtime/realtime.module';
import { CallSessionStoreModule } from '../calls/call-session-store.module';
import { MessagesController } from './messages.controller';
import { MessagesService } from './messages.service';
import { MessagesSupportService } from './messages-support.service';
import { MessagesQueryService } from './messages-query.service';
import { MessagesWriteService } from './messages-write.service';

@Module({
  imports: [AuthModule, RealtimeModule, CallSessionStoreModule],
  controllers: [MessagesController],
  providers: [MessagesSupportService, MessagesQueryService, MessagesWriteService, MessagesService],
  exports: [MessagesService],
})
export class MessagesModule {}
