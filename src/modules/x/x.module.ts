import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module';
import { PrismaModule } from '../prisma/prisma.module';
import { RealtimeModule } from '../realtime/realtime.module';
import { UsersModule } from '../users/users.module';
import { XApiClient } from './x-api.client';
import { XConnectionService } from './x-connection.service';
import { XCrosspostService } from './x-crosspost.service';
import { XSideEffectsHandler } from './x-side-effects.handler';
import { XController } from './x.controller';

@Module({
  imports: [AuthModule, PrismaModule, RealtimeModule, UsersModule],
  controllers: [XController],
  providers: [XApiClient, XConnectionService, XCrosspostService, XSideEffectsHandler],
  exports: [XCrosspostService],
})
export class XModule {}
