import type { AppConfigService } from '../app/app-config.service';
import type { PresenceService } from '../presence/presence.service';
import type { PostsReadService } from '../posts-read/posts-read.service';
import type { PrismaService } from '../prisma/prisma.service';
import type { CacheService } from '../redis/cache.service';
import type { ApnsPushService } from './apns-push.service';
import type { NotificationPreferencesService } from './notification-preferences.service';
import { NotificationPushDeliveryService } from './notification-push-delivery.service';
import { NotificationPushKindService } from './notification-push-kind.service';
import { NotificationPushService } from './notification-push.service';

/** Wires NotificationPushService and its collaborators by hand for unit tests (the module does this through DI). */
export function makeNotificationPushService(
  prisma: PrismaService,
  appConfig: AppConfigService,
  presence: PresenceService,
  preferences: NotificationPreferencesService,
  apnsPush: ApnsPushService,
  cache: CacheService,
  postsRead: PostsReadService,
): NotificationPushService {
  const delivery = new NotificationPushDeliveryService(prisma, appConfig, apnsPush, cache);
  const kindPush = new NotificationPushKindService(delivery, appConfig, postsRead, preferences, prisma);
  return new NotificationPushService(prisma, appConfig, presence, preferences, apnsPush, delivery, kindPush);
}
