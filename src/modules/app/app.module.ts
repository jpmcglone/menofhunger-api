import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { AppController } from './app.controller';
import { envSchema, validateEnv } from './env';
import { HealthModule } from '../health/health.module';
import { PrismaModule } from '../prisma/prisma.module';

@Module({
  imports: [
    ConfigModule.forRoot({
      isGlobal: true,
      validate: validateEnv(envSchema),
    }),
    HealthModule,
    PrismaModule,
  ],
  controllers: [AppController],
})
export class AppModule {}

