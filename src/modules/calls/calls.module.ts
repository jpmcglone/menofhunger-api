import { Module } from '@nestjs/common';
import { MessagesModule } from '../messages/messages.module';
import { RealtimeModule } from '../realtime/realtime.module';
import { CallSessionStoreModule } from './call-session-store.module';
import { CallsService } from './calls.service';

/**
 * DM voice/video calling. No HTTP surface: lifecycle runs over acked Socket.IO events
 * (see `gateway-calls.handler.ts`) and the on-load sync is `MessageConversationDto.activeCall`.
 */
@Module({
  imports: [MessagesModule, RealtimeModule, CallSessionStoreModule],
  providers: [CallsService],
  exports: [CallsService, CallSessionStoreModule],
})
export class CallsModule {}
