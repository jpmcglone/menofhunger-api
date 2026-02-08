import { Module } from '@nestjs/common';
import { APP_GUARD } from '@nestjs/core';
import { ConfigModule } from '@nestjs/config';
import { ScheduleModule } from '@nestjs/schedule';
import { ThrottlerModule } from '@nestjs/throttler';
import { AppController } from './app.controller';
import { envSchema, validateEnv } from './env';
import { AppConfigModule } from './app-config.module';
import { AppConfigService } from './app-config.service';
import { MohThrottlerGuard } from '../../common/throttling/moh-throttler.guard';
import { RequestCacheModule } from '../../common/cache/request-cache.module';
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
import { PresenceModule } from '../presence/presence.module';
import { NotificationsModule } from '../notifications/notifications.module';
import { LinkMetadataModule } from '../link-metadata/link-metadata.module';
import { FeedbackModule } from '../feedback/feedback.module';
import { MessagesModule } from '../messages/messages.module';
import { VerificationModule } from '../verification/verification.module';
import { ReportsModule } from '../reports/reports.module';
import { Websters1828Module } from '../websters1828/websters1828.module';
import { RadioModule } from '../radio/radio.module';
import { TopicsModule } from '../topics/topics.module';
import { HashtagsModule } from '../hashtags/hashtags.module';

@Module({
  imports: [
    ScheduleModule.forRoot(),
    RequestCacheModule,
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
    VerificationModule,
    AdminModule,
    UploadsModule,
    PostsModule,
    FollowsModule,
    GiphyModule,
    BookmarksModule,
    SearchModule,
    PresenceModule,
    NotificationsModule,
    LinkMetadataModule,
    FeedbackModule,
    ReportsModule,
    MessagesModule,
    Websters1828Module,
    RadioModule,
    TopicsModule,
    HashtagsModule,
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

