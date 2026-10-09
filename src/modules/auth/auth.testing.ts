import type { AppConfigService } from '../app/app-config.service';
import type { PostsReadService } from '../posts-read/posts-read.service';
import type { PresenceRealtimeService } from '../presence/presence-realtime.service';
import type { PresenceService } from '../presence/presence.service';
import type { PrismaService } from '../prisma/prisma.service';
import type { CacheInvalidationService } from '../redis/cache-invalidation.service';
import type { RedisService } from '../redis/redis.service';
import type { SideEffectsService } from '../side-effects/side-effects.service';
import type { SlackService } from '../../common/slack/slack.service';
import type { PosthogService } from '../../common/posthog/posthog.service';
import type { RequestCacheService } from '../../common/cache/request-cache.service';
import { AuthSessionResolverService } from './auth-session-resolver.service';
import { AuthService } from './auth.service';
import type { OtpProvider } from './otp/otp-provider';

/** Wires AuthService and its session resolver by hand for unit tests (the module does this through DI). */
export function makeAuthService(
  prisma: PrismaService,
  appConfig: AppConfigService,
  cacheInvalidation: CacheInvalidationService,
  redis: RedisService,
  otpProvider: OtpProvider,
  posthog: PosthogService,
  slack: SlackService,
  requestCache: RequestCacheService,
  presence: PresenceService,
  presenceRealtime: PresenceRealtimeService,
  sideEffects: SideEffectsService,
  postsRead: PostsReadService,
): AuthService {
  const sessions = new AuthSessionResolverService(appConfig, cacheInvalidation, postsRead, presence, prisma, redis, requestCache);
  return new AuthService(prisma, appConfig, cacheInvalidation, redis, otpProvider, posthog, slack, presence, presenceRealtime, sideEffects, sessions);
}
