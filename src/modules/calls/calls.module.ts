import { Module } from '@nestjs/common';
import { MessagesModule } from '../messages/messages.module';
import { NotificationsModule } from '../notifications/notifications.module';
import { RealtimeModule } from '../realtime/realtime.module';
import { CallSessionStoreModule } from './call-session-store.module';
import { CallsSideEffectsHandler } from './calls-side-effects.handler';
import { CallsSweepCron } from './calls-sweep.cron';
import { CallsService } from './calls.service';

/**
 * DM voice/video calling. No HTTP surface: lifecycle runs over acked Socket.IO events
 * (see `gateway-calls.handler.ts`) and the on-load sync is `MessageConversationDto.activeCall`.
 * The only push is the PushKit ring for iPhones, sent from the side-effects worker.
 * `CallsSweepCron` is the liveness backstop that ends calls whose participants are all gone.
 */
@Module({
  imports: [MessagesModule, NotificationsModule, RealtimeModule, CallSessionStoreModule],
  providers: [CallsService, CallsSideEffectsHandler, CallsSweepCron],
  exports: [CallsService, CallSessionStoreModule],
})
export class CallsModule {}
