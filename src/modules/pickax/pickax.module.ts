import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module';
import { PrismaModule } from '../prisma/prisma.module';
import { UsersModule } from '../users/users.module';
import { PickaxApiClient } from './pickax-api.client';
import { PickaxConnectionService } from './pickax-connection.service';
import { PickaxCrosspostService } from './pickax-crosspost.service';
import { PickaxSideEffectsHandler } from './pickax-side-effects.handler';
import { PickaxController } from './pickax.controller';

@Module({
  imports: [AuthModule, PrismaModule, UsersModule],
  controllers: [PickaxController],
  providers: [PickaxApiClient, PickaxConnectionService, PickaxCrosspostService, PickaxSideEffectsHandler],
  exports: [PickaxCrosspostService],
})
export class PickaxModule {}
