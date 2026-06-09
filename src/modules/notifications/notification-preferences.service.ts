import { Injectable } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import type { NotificationPreferencesDto } from '../../common/dto';

/**
 * Notification preference storage. Owns the upsert-on-read row lifecycle and
 * the email-verification gate on email-channel preferences.
 */
@Injectable()
export class NotificationPreferencesService {
  constructor(private readonly prisma: PrismaService) {}

  /** Raw preferences row (creates defaults on first read). Internal shape, not the DTO. */
  async getPreferencesInternal(userId: string) {
    return await this.prisma.notificationPreferences.upsert({
      where: { userId },
      create: { userId },
      update: {},
    });
  }

  async getPreferences(userId: string): Promise<NotificationPreferencesDto> {
    const prefs = await this.getPreferencesInternal(userId);
    return this.toDto(prefs);
  }

  async updatePreferences(userId: string, patch: Partial<NotificationPreferencesDto>): Promise<NotificationPreferencesDto> {
    // Email prefs are only meaningful for verified emails. Keep the stored settings,
    // but prevent toggling them until the user verifies their email.
    const wantsEmailPatch =
      patch.emailDigestDaily !== undefined ||
      patch.emailDigestWeekly !== undefined ||
      patch.emailNewNotifications !== undefined ||
      patch.emailInstantHighSignal !== undefined ||
      patch.emailStreakReminder !== undefined ||
      patch.emailFollowedArticle !== undefined;

    let effectivePatch = patch;
    if (wantsEmailPatch) {
      const u = await this.prisma.user.findUnique({
        where: { id: userId },
        select: { email: true, emailVerifiedAt: true },
      });
      const canUseEmail = Boolean((u?.email ?? '').trim()) && Boolean(u?.emailVerifiedAt);
      if (!canUseEmail) {
        effectivePatch = { ...patch };
        delete effectivePatch.emailDigestDaily;
        delete effectivePatch.emailDigestWeekly;
        delete effectivePatch.emailNewNotifications;
        delete effectivePatch.emailInstantHighSignal;
        delete effectivePatch.emailStreakReminder;
        delete effectivePatch.emailFollowedArticle;
      }
    }

    const updated = await this.prisma.notificationPreferences.upsert({
      where: { userId },
      create: { userId, ...(effectivePatch as any) },
      update: effectivePatch as any,
    });
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
    emailDigestDaily: boolean;
    emailDigestWeekly: boolean;
    emailNewNotifications: boolean;
    emailInstantHighSignal: boolean;
    emailStreakReminder: boolean;
    emailFollowedArticle: boolean;
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
      emailDigestDaily: Boolean(prefs.emailDigestDaily),
      emailDigestWeekly: Boolean(prefs.emailDigestWeekly),
      emailNewNotifications: Boolean(prefs.emailNewNotifications),
      emailInstantHighSignal: Boolean(prefs.emailInstantHighSignal),
      emailStreakReminder: Boolean(prefs.emailStreakReminder),
      emailFollowedArticle: Boolean(prefs.emailFollowedArticle),
    };
  }
}
