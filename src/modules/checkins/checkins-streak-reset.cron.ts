import { Injectable, Logger } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import { PrismaService } from '../prisma/prisma.service';
import { JobsService } from '../jobs/jobs.service';
import { AppConfigService } from '../app/app-config.service';
import { JOBS } from '../jobs/jobs.constants';
import { easternDayKey, yesterdayEasternDayKey } from '../../common/time/eastern-day-key';

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

    // A user's streak is still valid if their last post was today OR yesterday (ET).
    // Everyone else with a non-zero streak has missed at least one full day and should be reset.
    const result = await this.prisma.user.updateMany({
      where: {
        checkinStreakDays: { gt: 0 },
        OR: [
          { lastCheckinDayKey: null },
          { lastCheckinDayKey: { notIn: [todayKey, yesterdayKey] } },
        ],
      },
      data: { checkinStreakDays: 0 },
    });

    if (result.count > 0) {
      this.logger.log(
        `[streak-reset] Reset streaks for ${result.count} user(s) ` +
          `(todayKey=${todayKey}, yesterdayKey=${yesterdayKey})`,
      );
    } else {
      this.logger.debug(
        `[streak-reset] No streaks to reset (todayKey=${todayKey}, yesterdayKey=${yesterdayKey})`,
      );
    }
  }
}
