import { Module } from '@nestjs/common';
import { APP_GUARD } from '@nestjs/core';
import { ConfigModule } from '@nestjs/config';
import { ThrottlerModule } from '@nestjs/throttler';
import { AppController } from './app.controller';
import { envSchema, validateEnv } from './env';
import { AppConfigModule } from './app-config.module';
import { AppConfigService } from './app-config.service';
import { MohThrottlerGuard } from '../../common/throttling/moh-throttler.guard';
import { HealthModule } from '../health/health.module';
import { PrismaModule } from '../prisma/prisma.module';
import { AuthModule } from '../auth/auth.module';
import { UsersModule } from '../users/users.module';
import { AdminModule } from '../admin/admin.module';
import { UploadsModule } from '../uploads/uploads.module';
import { PostsModule } from '../posts/posts.module';
import { FollowsModule } from '../follows/follows.module';
import { GiphyModule } from '../giphy/giphy.module';
import { BookmarksModule } from '../bookmarks/bookmarks.module';
import { SearchModule } from '../search/search.module';

@Module({
  imports: [
    ConfigModule.forRoot({
      isGlobal: true,
      validate: validateEnv(envSchema),
    }),
    AppConfigModule,
    ThrottlerModule.forRootAsync({
      inject: [AppConfigService],
      useFactory: (cfg: AppConfigService) => [
        {
          ttl: cfg.rateLimitTtlSeconds(),
          limit: cfg.rateLimitLimit(),
        },
      ],
    }),
    HealthModule,
    PrismaModule,
    AuthModule,
    UsersModule,
    AdminModule,
    UploadsModule,
    PostsModule,
    FollowsModule,
    GiphyModule,
    BookmarksModule,
    SearchModule,
  ],
  controllers: [AppController],
  providers: [
    {
      provide: APP_GUARD,
      useClass: MohThrottlerGuard,
    },
  ],
})
export class AppModule {}

