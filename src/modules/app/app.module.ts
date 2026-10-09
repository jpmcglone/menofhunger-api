import { OutboundModule } from '../outbound/outbound.service';
import { AvatarVideoConsumersModule } from '../uploads/avatar-video.module';
import { Module } from '@nestjs/common';
import { APP_GUARD } from '@nestjs/core';
import { ConfigModule } from '@nestjs/config';
import { SentryModule } from '@sentry/nestjs/setup';
import { ScheduleModule } from '@nestjs/schedule';
import { ThrottlerModule } from '@nestjs/throttler';
import { BullModule } from '@nestjs/bullmq';
import { AppController } from './app.controller';
import { envSchema, validateEnv } from './env';
import { AppConfigModule } from './app-config.module';
import { AppConfigService } from './app-config.service';
import { SiteConfigModule } from '../site-config/site-config.module';
import { MohThrottlerGuard } from '../../common/throttling/moh-throttler.guard';
import { RequestCacheModule } from '../../common/cache/request-cache.module';
import { PrismaModule } from '../prisma/prisma.module';
import { JobsModule } from '../jobs/jobs.module';
import { JobsConsumersModule } from '../jobs/jobs-consumers.module';
import { SideEffectsModule } from '../side-effects/side-effects.module';
import { SideEffectsConsumersModule } from '../side-effects/side-effects-consumers.module';
import { RedisModule } from '../redis/redis.module';
import { RealtimeModule } from '../realtime/realtime.module';
import { ViewerContextModule } from '../viewer/viewer-context.module';
import { PostsReadModule } from '../posts-read/posts-read.module';
import { UserLookupModule } from '../user-lookup/user-lookup.module';
import { DomainEventsModule } from '../events/domain-events.module';
import { AuthModule } from '../auth/auth.module';

import { IdentityFeaturesModule } from './identity-features.module';
import { ContentFeaturesModule } from './content-features.module';
import { CommunityFeaturesModule } from './community-features.module';
import { IntegrationFeaturesModule } from './integration-features.module';

// Module wiring is static; use env flags as a pragmatic switch for which processes host consumers.
const RUN_JOB_CONSUMERS_RAW = (process.env.RUN_JOB_CONSUMERS ?? 'true').trim().toLowerCase();
const RUN_JOB_CONSUMERS = RUN_JOB_CONSUMERS_RAW === '' ? true : ['1', 'true', 'yes', 'on'].includes(RUN_JOB_CONSUMERS_RAW);

@Module({
  imports: [
    SentryModule.forRoot(),
    ScheduleModule.forRoot(),
    RequestCacheModule,
    ConfigModule.forRoot({
      isGlobal: true,
      validate: validateEnv(envSchema),
    }),
    AppConfigModule,
    SiteConfigModule,
    ViewerContextModule,
    PostsReadModule,
    UserLookupModule,
    DomainEventsModule,
    RealtimeModule,
    BullModule.forRootAsync({
      inject: [AppConfigService],
      useFactory: (cfg: AppConfigService) => ({
        connection: { url: cfg.redisUrl() },
      }),
    }),
    JobsModule,
    SideEffectsModule,
    OutboundModule,
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
    PrismaModule,
    // The global MohThrottlerGuard injects AuthService, so AppModule must import AuthModule itself.
    AuthModule,
    IdentityFeaturesModule,
    ContentFeaturesModule,
    CommunityFeaturesModule,
    IntegrationFeaturesModule,
    ...(RUN_JOB_CONSUMERS ? [JobsConsumersModule, SideEffectsConsumersModule, AvatarVideoConsumersModule] : []),
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

