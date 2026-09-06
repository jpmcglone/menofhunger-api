import { ConversationsModule } from '../posts/conversations.module';
import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module';
import { PrismaModule } from '../prisma/prisma.module';
import { NotificationsModule } from '../notifications/notifications.module';
import { UsersModule } from '../users/users.module';
import { CoinsController } from './coins.controller';
import { CoinsService } from './coins.service';
import { CoinsSideEffectsHandler } from './coins-side-effects.handler';

@Module({
  imports: [ConversationsModule, AuthModule, PrismaModule, NotificationsModule, UsersModule],
  controllers: [CoinsController],
  providers: [CoinsService, CoinsSideEffectsHandler],
  exports: [CoinsService],
})
export class CoinsModule {}
