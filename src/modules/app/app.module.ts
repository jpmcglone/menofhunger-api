import { Module } from '@nestjs/common';
import { APP_GUARD } from '@nestjs/core';
import { ConfigModule } from '@nestjs/config';
import { ScheduleModule } from '@nestjs/schedule';
import { ThrottlerModule } from '@nestjs/throttler';
import { BullModule } from '@nestjs/bullmq';
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
import { MetricsModule } from '../metrics/metrics.module';
import { BillingModule } from '../billing/billing.module';
import { JobsModule } from '../jobs/jobs.module';
import { JobsConsumersModule } from '../jobs/jobs-consumers.module';
import { RedisModule } from '../redis/redis.module';
import { RealtimeModule } from '../realtime/realtime.module';
import { ViewerContextModule } from '../viewer/viewer-context.module';
import { DomainEventsModule } from '../events/domain-events.module';

// Module wiring is static; use env flags as a pragmatic switch for which processes host consumers.
const RUN_JOB_CONSUMERS_RAW = (process.env.RUN_JOB_CONSUMERS ?? 'true').trim().toLowerCase();
const RUN_JOB_CONSUMERS = RUN_JOB_CONSUMERS_RAW === '' ? true : ['1', 'true', 'yes', 'on'].includes(RUN_JOB_CONSUMERS_RAW);

@Module({
  imports: [
    ScheduleModule.forRoot(),
    RequestCacheModule,
    ConfigModule.forRoot({
      isGlobal: true,
      validate: validateEnv(envSchema),
    }),
    AppConfigModule,
    ViewerContextModule,
    DomainEventsModule,
    RealtimeModule,
    BullModule.forRootAsync({
      inject: [AppConfigService],
      useFactory: (cfg: AppConfigService) => ({
        connection: { url: cfg.redisUrl() },
      }),
    }),
    JobsModule,
    RedisModule,
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
    MetricsModule,
    BillingModule,
    ...(RUN_JOB_CONSUMERS ? [JobsConsumersModule] : []),
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

