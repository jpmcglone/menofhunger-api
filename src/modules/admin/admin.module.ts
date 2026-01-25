import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module';
import { PrismaModule } from '../prisma/prisma.module';
import { AdminGuard } from './admin.guard';
import { AdminUsersController } from './admin-users.controller';

@Module({
  imports: [AuthModule, PrismaModule],
  controllers: [AdminUsersController],
  providers: [AdminGuard],
})
export class AdminModule {}

