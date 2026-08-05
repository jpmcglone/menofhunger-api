import { Injectable, Logger } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import { PrismaService } from '../prisma/prisma.service';
import { JobsService } from '../jobs/jobs.service';
import { AppConfigService } from '../app/app-config.service';
import { JOBS } from '../jobs/jobs.constants';
import { easternDayKey, yesterdayEasternDayKey } from '../../common/time/eastern-day-key';
import { PresenceRealtimeService } from '../presence/presence-realtime.service';
import { RedisService } from '../redis/redis.service';
import { RedisKeys } from '../redis/redis-keys';
import { NotificationsService } from '../notifications/notifications.service';

const ET_ZONE = 'America/New_York';

function easternHour(d: Date): number {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: ET_ZONE,
    hour: '2-digit',
    hour12: false,
  }).formatToParts(d);
  const raw = Number(parts.find((p) => p.type === 'hour')?.value ?? 0);
  return Number.isFinite(raw) ? ((raw % 24) + 24) % 24 : 0;
}

/**
 * Nightly job that resets checkinStreakDays to 0 for every user who did not
 * post on the previous ET calendar day (or today). Without this, stale streak
 * values linger in the DB forever because the reset logic only fires when a
 * user posts.
 */
@Injectable()
export class CheckinsStreakResetCron {
  private readonly logger = new Logger(CheckinsStreakResetCron.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly jobs: JobsService,
    private readonly appConfig: AppConfigService,
    private readonly presenceRealtime: PresenceRealtimeService,
    private readonly redis: RedisService,
    private readonly notifications: NotificationsService,
  ) {}

  /** Fire in the 1:00–1:59 am ET window, once per day (deduplicated by dayKey). */
  @Cron('*/5 * * * *')
  async scheduleStreakReset(): Promise<void> {
    if (!this.appConfig.runSchedulers()) return;
    const now = new Date();
    if (easternHour(now) !== 1) return;
    const dayKey = easternDayKey(now);
    try {
      await this.jobs.enqueueCron(
        JOBS.checkinsStreakReset,
        {},
        `cron-checkinsStreakReset-${dayKey}`,
        { attempts: 3, backoff: { type: 'exponential', delay: 5 * 60_000 } },
      );
    } catch {
      // Duplicate jobId means it was already enqueued for this day — safe to ignore.
    }
  }

  async runStreakReset(): Promise<void> {
    const now = new Date();
    const todayKey = easternDayKey(now);
    const yesterdayKey = yesterdayEasternDayKey(now);

    // Find users whose streaks need resetting before we lose the current count.
    const toReset = await this.prisma.user.findMany({
      where: {
        checkinStreakDays: { gt: 0 },
        OR: [
          { lastCheckinDayKey: null },
          { lastCheckinDayKey: { notIn: [todayKey, yesterdayKey] } },
        ],
      },
      select: { id: true, checkinStreakDays: true },
    });

    if (toReset.length === 0) {
      this.logger.debug(
        `[streak-reset] No streaks to reset (todayKey=${todayKey}, yesterdayKey=${yesterdayKey})`,
      );
      await this.runCrewStreakReset({ todayKey, yesterdayKey });
      return;
    }

    await this.prisma.user.updateMany({
      where: { id: { in: toReset.map((u) => u.id) } },
      data: { checkinStreakDays: 0 },
    });

    this.logger.log(
      `[streak-reset] Reset streaks for ${toReset.length} user(s) ` +
        `(todayKey=${todayKey}, yesterdayKey=${yesterdayKey})`,
    );

    // Update any still-unread "Have you checked in today?" reminders so the user
    // sees accurate text instead of a stale call-to-action.
    await this.updateStaleCheckinReminders(toReset);

    await this.runCrewStreakReset({ todayKey, yesterdayKey });
  }

  /**
   * For each user whose streak just broke, flip their unread checkin_reminder
   * notification to say "Streak ended" so they don't see the stale call-to-action.
   * Tapping the updated notification still navigates to the check-in composer,
   * letting them start a fresh streak today.
   */
  private async updateStaleCheckinReminders(
    users: { id: string; checkinStreakDays: number }[],
  ): Promise<void> {
    for (const user of users) {
      const n = user.checkinStreakDays;
      const title = n > 1 ? `Your ${n}-day streak ended` : 'Your streak ended';
      await this.prisma.notification.updateMany({
        where: {
          recipientUserId: user.id,
          kind: 'checkin_reminder',
          readAt: null,
        },
        data: {
          title,
          body: 'Check in today to start a new one.',
        },
      });
    }
  }

  /**
   * Strict crew streak reset: every crew whose `lastCompletedDayKey` is not
   * yesterday (and not today — handles the rare case of a same-day full sweep
   * after the cron fires) loses its current streak. We emit `crew:streak:broken`
   * to all members with the names of who didn't check in yesterday — that's the
   * behavioral nudge that drives next-day return.
   */
  private async runCrewStreakReset(params: { todayKey: string; yesterdayKey: string }): Promise<void> {
    const { todayKey, yesterdayKey } = params;

    const brokenCrews = await this.prisma.crew.findMany({
      where: {
        deletedAt: null,
        currentStreakDays: { gt: 0 },
        OR: [
          { lastCompletedDayKey: null },
          { lastCompletedDayKey: { notIn: [todayKey, yesterdayKey] } },
        ],
      },
      select: {
        id: true,
        slug: true,
        name: true,
        members: {
          select: {
            userId: true,
            user: { select: { id: true, username: true, name: true } },
          },
        },
      },
    });

    if (brokenCrews.length === 0) {
      this.logger.debug(`[crew-streak-reset] No crew streaks to reset (yesterdayKey=${yesterdayKey})`);
      return;
    }

    let resetCount = 0;
    for (const crew of brokenCrews) {
      const memberIds = crew.members.map((m) => m.userId);
      if (memberIds.length === 0) continue;

      // Identify who actually missed yesterday so we can name names in the push/UI.
      const checkedIn = await this.prisma.post.findMany({
        where: {
          kind: 'checkin',
          checkinDayKey: yesterdayKey,
          deletedAt: null,
          userId: { in: memberIds },
        },
        select: { userId: true },
      });
      const checkedInSet = new Set(checkedIn.map((p) => p.userId));
      const missedMembers = crew.members
        .filter((m) => !checkedInSet.has(m.userId))
        .map((m) => ({
          id: m.user.id,
          username: m.user.username,
          displayName: (m.user.name ?? m.user.username ?? '').trim() || null,
        }));

      const updated = await this.prisma.crew.updateMany({
        where: {
          id: crew.id,
          currentStreakDays: { gt: 0 },
          OR: [
            { lastCompletedDayKey: null },
            { lastCompletedDayKey: { notIn: [todayKey, yesterdayKey] } },
          ],
        },
        data: { currentStreakDays: 0 },
      });
      if (updated.count === 0) continue;

      resetCount += 1;
      this.presenceRealtime.emitCrewStreakBroken(memberIds, {
        crewId: crew.id,
        missedDayKey: yesterdayKey,
        missedMembers,
      });

      // Bust today-state cache for every member so the next /checkins/today
      // reflects the reset crew streak block.
      for (const memberId of memberIds) {
        void this.redis.del(RedisKeys.checkinTodayState(memberId, todayKey)).catch(() => undefined);
      }

      // Morning-after push naming who didn't check in. The most behaviorally
      // potent push in the product — gated by per-user pushCrewStreak pref.
      void this.notifications
        .sendCrewStreakBrokenPush({
          recipientUserIds: memberIds,
          crewId: crew.id,
          crewSlug: crew.slug,
          crewName: crew.name,
          missedMembers,
        })
        .catch((err) => {
          this.logger.warn(
            `[crew-streak-reset] Push fan-out failed for crew ${crew.id}: ${err instanceof Error ? err.message : String(err)}`,
          );
        });
    }

    if (resetCount > 0) {
      this.logger.log(
        `[crew-streak-reset] Reset crew streaks for ${resetCount} crew(s) ` +
          `(todayKey=${todayKey}, yesterdayKey=${yesterdayKey})`,
      );
    }
  }
}
