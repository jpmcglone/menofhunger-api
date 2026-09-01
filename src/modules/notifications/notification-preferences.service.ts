import { Injectable } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { CacheService } from '../redis/cache.service';
import { RedisKeys } from '../redis/redis-keys';
import { CacheTtl } from '../redis/cache-ttl';
import type { NotificationPreferencesDto } from '../../common/dto';

/**
 * Notification preference storage. Owns the upsert-on-read row lifecycle and
 * the email-verification gate on email-channel preferences.
 *
 * Preferences are cached in Redis for 5 minutes to avoid a DB round-trip on
 * every notification push. The cache is invalidated on every write so users see
 * their setting changes reflected in the next push cycle.
 */
@Injectable()
export class NotificationPreferencesService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly cache: CacheService,
  ) {}

  /** Raw preferences row (creates defaults on first read). Internal shape, not the DTO. */
  async getPreferencesInternal(userId: string) {
    return await this.cache.getOrSetJson({
      enabled: Boolean(userId),
      key: RedisKeys.pushPrefs(userId),
      ttlSeconds: CacheTtl.pushPrefsSeconds,
      compute: () =>
        this.prisma.notificationPreferences.upsert({
          where: { userId },
          create: { userId },
          update: {},
        }),
    });
  }

  /** Flip lodge-newsletter opt-in without the verified-email gate (one-click unsubscribe). */
  async setEmailNewsletter(userId: string, enabled: boolean): Promise<void> {
    void this.cache.del(RedisKeys.pushPrefs(userId)).catch(() => undefined);
    const updated = await this.prisma.notificationPreferences.upsert({
      where: { userId },
      create: { userId, emailNewsletter: enabled },
      update: { emailNewsletter: enabled },
    });
    void this.cache.setJson(RedisKeys.pushPrefs(userId), updated, { ttlSeconds: CacheTtl.pushPrefsSeconds }).catch(() => undefined);
  }

  async getPreferences(userId: string): Promise<NotificationPreferencesDto> {
    const prefs = await this.getPreferencesInternal(userId);
    return this.toDto(prefs);
  }

  async updatePreferences(userId: string, patch: Partial<NotificationPreferencesDto>): Promise<NotificationPreferencesDto> {
    void this.cache.del(RedisKeys.pushPrefs(userId)).catch(() => undefined);
    // Email prefs are only meaningful for verified emails. Keep the stored settings,
    // but prevent toggling them until the user verifies their email.
    const wantsEmailPatch =
      patch.emailDigestWeekly !== undefined ||
      patch.emailNewNotifications !== undefined ||
      patch.emailInstantHighSignal !== undefined ||
      patch.emailStreakReminder !== undefined ||
      patch.emailFollowedArticle !== undefined ||
      patch.emailNewsletter !== undefined;

    let effectivePatch = patch;
    if (wantsEmailPatch) {
      const u = await this.prisma.user.findUnique({
        where: { id: userId },
        select: { email: true, emailVerifiedAt: true },
      });
      const canUseEmail = Boolean((u?.email ?? '').trim()) && Boolean(u?.emailVerifiedAt);
      if (!canUseEmail) {
        effectivePatch = { ...patch };
        delete effectivePatch.emailDigestWeekly;
        delete effectivePatch.emailNewNotifications;
        delete effectivePatch.emailInstantHighSignal;
        delete effectivePatch.emailStreakReminder;
        delete effectivePatch.emailFollowedArticle;
        delete effectivePatch.emailNewsletter;
      }
    }

    const updated = await this.prisma.notificationPreferences.upsert({
      where: { userId },
      create: { userId, ...(effectivePatch as any) },
      update: effectivePatch as any,
    });
    void this.cache.setJson(RedisKeys.pushPrefs(userId), updated, { ttlSeconds: CacheTtl.pushPrefsSeconds }).catch(() => undefined);
    return this.toDto(updated);
  }

  private toDto(prefs: {
    pushComment: boolean;
    pushBoost: boolean;
    pushFollow: boolean;
    pushMention: boolean;
    pushMessage: boolean;
    pushRepost: boolean;
    pushNudge: boolean;
    pushFollowedPost: boolean;
    pushReplyNudge: boolean;
    pushCrewStreak: boolean;
    pushGroupActivity: boolean;
    pushDailyContent: boolean;
    pushCheckinReminder: boolean;
    emailDigestWeekly: boolean;
    emailNewNotifications: boolean;
    emailInstantHighSignal: boolean;
    emailStreakReminder: boolean;
    emailFollowedArticle: boolean;
    emailNewsletter: boolean;
  }): NotificationPreferencesDto {
    return {
      pushComment: Boolean(prefs.pushComment),
      pushBoost: Boolean(prefs.pushBoost),
      pushFollow: Boolean(prefs.pushFollow),
      pushMention: Boolean(prefs.pushMention),
      pushMessage: Boolean(prefs.pushMessage),
      pushRepost: Boolean(prefs.pushRepost),
      pushNudge: Boolean(prefs.pushNudge),
      pushFollowedPost: Boolean(prefs.pushFollowedPost),
      pushReplyNudge: Boolean(prefs.pushReplyNudge),
      pushCrewStreak: Boolean(prefs.pushCrewStreak),
      pushGroupActivity: Boolean(prefs.pushGroupActivity),
      pushDailyContent: Boolean(prefs.pushDailyContent),
      pushCheckinReminder: Boolean(prefs.pushCheckinReminder),
      emailDigestWeekly: Boolean(prefs.emailDigestWeekly),
      emailNewNotifications: Boolean(prefs.emailNewNotifications),
      emailInstantHighSignal: Boolean(prefs.emailInstantHighSignal),
      emailStreakReminder: Boolean(prefs.emailStreakReminder),
      emailFollowedArticle: Boolean(prefs.emailFollowedArticle),
      emailNewsletter: prefs.emailNewsletter !== false,
    };
  }
}
