import { Injectable } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import { JobsService } from '../jobs/jobs.service';
import { JOBS } from '../jobs/jobs.constants';
import { AppConfigService } from '../app/app-config.service';
import { easternDayKey, easternMinuteOfDay } from '../../common/time/eastern-day-key';
import { ON_THIS_DAY_CLOSES_MINUTE, ON_THIS_DAY_OPENS_MINUTE } from '../checkins/checkin-schedule';

/**
 * Enqueues the "On This Day" fan-out once per day at 8am ET.
 * Morning-only: a process that comes back after noon ET skips that day's send.
 * Guard: `onThisDayNotifiedAt` on the DailyContentSnapshot prevents double fan-out.
 */
@Injectable()
export class OnThisDayCron {
  constructor(
    private readonly jobs: JobsService,
    private readonly appConfig: AppConfigService,
  ) {}

  @Cron('*/5 * * * *')
  async scheduleOnThisDay(): Promise<void> {
    if (!this.appConfig.runSchedulers()) return;
    const now = new Date();
    const minuteOfDay = easternMinuteOfDay(now);
    if (minuteOfDay < ON_THIS_DAY_OPENS_MINUTE || minuteOfDay >= ON_THIS_DAY_CLOSES_MINUTE) return;
    const dayKey = easternDayKey(now);
    try {
      await this.jobs.enqueueCron(
        JOBS.onThisDayFanout,
        { dayKey },
        `cron:onThisDayFanout:${dayKey}`,
        { attempts: 3, backoff: { type: 'exponential', delay: 5 * 60_000 } },
      );
    } catch {
      // Duplicate jobId — already enqueued for today; safe no-op.
    }
  }
}
