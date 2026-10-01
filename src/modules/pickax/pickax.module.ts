import { PickaxOAuthService } from './pickax-oauth.service';
import { PickaxOAuthClient } from './pickax-oauth.client';
import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module';
import { PrismaModule } from '../prisma/prisma.module';
import { RealtimeModule } from '../realtime/realtime.module';
import { UsersModule } from '../users/users.module';
import { PickaxApiClient } from './pickax-api.client';
import { PickaxConnectionService } from './pickax-connection.service';
import { PickaxCrosspostService } from './pickax-crosspost.service';
import { PickaxSideEffectsHandler } from './pickax-side-effects.handler';
import { PickaxController } from './pickax.controller';

@Module({
  imports: [AuthModule, PrismaModule, RealtimeModule, UsersModule],
  controllers: [PickaxController],
  providers: [PickaxOAuthClient, PickaxOAuthService, PickaxApiClient, PickaxConnectionService, PickaxCrosspostService, PickaxSideEffectsHandler],
  exports: [PickaxCrosspostService],
})
export class PickaxModule {}
