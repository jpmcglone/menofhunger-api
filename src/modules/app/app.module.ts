import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { AppController } from './app.controller';
import { envSchema, validateEnv } from './env';
import { AppConfigModule } from './app-config.module';
import { HealthModule } from '../health/health.module';
import { PrismaModule } from '../prisma/prisma.module';
import { AuthModule } from '../auth/auth.module';
import { UsersModule } from '../users/users.module';
import { AdminModule } from '../admin/admin.module';
import { UploadsModule } from '../uploads/uploads.module';

@Module({
  imports: [
    ConfigModule.forRoot({
      isGlobal: true,
      validate: validateEnv(envSchema),
    }),
    AppConfigModule,
    HealthModule,
    PrismaModule,
    AuthModule,
    UsersModule,
    AdminModule,
    UploadsModule,
  ],
  controllers: [AppController],
})
export class AppModule {}

