import { Injectable, Logger } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import { JobsService } from '../jobs/jobs.service';
import { JOBS } from '../jobs/jobs.constants';
import { AppConfigService } from '../app/app-config.service';
import { easternDayKey, easternMinuteOfDay } from '../../common/time/eastern-day-key';

/**
 * Enqueues the check-in reminder fan-out once per day at 6pm ET.
 * Guard: `checkinReminderNotifiedAt` on the DailyContentSnapshot prevents double fan-out.
 */
@Injectable()
export class CheckinReminderCron {
  private readonly logger = new Logger(CheckinReminderCron.name);

  constructor(
    private readonly jobs: JobsService,
    private readonly appConfig: AppConfigService,
  ) {}

  @Cron('*/5 * * * *')
  async scheduleCheckinReminder(): Promise<void> {
    if (!this.appConfig.runSchedulers()) return;
    const now = new Date();
    const minuteOfDay = easternMinuteOfDay(now);
    // Enqueue once the clock hits 6:00 PM ET (minute 1080).
    if (minuteOfDay < 18 * 60) return;
    const dayKey = easternDayKey(now);
    try {
      await this.jobs.enqueueCron(
        JOBS.checkinReminderFanout,
        { dayKey },
        `cron:checkinReminderFanout:${dayKey}`,
        { attempts: 3, backoff: { type: 'exponential', delay: 5 * 60_000 } },
      );
    } catch {
      // Duplicate jobId — already enqueued for today; safe no-op.
    }
  }
}
