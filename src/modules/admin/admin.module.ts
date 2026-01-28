import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module';
import { PrismaModule } from '../prisma/prisma.module';
import { AdminGuard } from './admin.guard';
import { AdminUsersController } from './admin-users.controller';
import { AdminSiteConfigController } from './admin-site-config.controller';

@Module({
  imports: [AuthModule, PrismaModule],
  controllers: [AdminUsersController, AdminSiteConfigController],
  providers: [AdminGuard],
})
export class AdminModule {}

