import { Module } from '@nestjs/common';
import { CallSessionStore } from './call-session.store';

/**
 * Split from CallsModule so MessagesModule can read `activeCall` for conversation DTOs
 * without importing the calls service (which itself depends on MessagesService).
 */
@Module({
  providers: [CallSessionStore],
  exports: [CallSessionStore],
})
export class CallSessionStoreModule {}
