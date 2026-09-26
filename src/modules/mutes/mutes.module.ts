import { Global, Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module';
import { RealtimeModule } from '../realtime/realtime.module';
import { MutesController } from './mutes.controller';
import { MutesService } from './mutes.service';

/** Global so feed, Board, notification, and profile reads can consult mutes without import cycles. */
@Global()
@Module({
  imports: [AuthModule, RealtimeModule],
  controllers: [MutesController],
  providers: [MutesService],
  exports: [MutesService],
})
export class MutesModule {}
