import { Injectable } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import { JobsService } from '../jobs/jobs.service';
import { JOBS } from '../jobs/jobs.constants';
import { AppConfigService } from '../app/app-config.service';
import { DailyContentService } from './daily-content.service';

@Injectable()
export class DailyContentCron {
  constructor(
    private readonly jobs: JobsService,
    private readonly appConfig: AppConfigService,
    private readonly dailyContent: DailyContentService,
  ) {}

  /** Every 5 minutes: ensure daily content snapshot exists and recheck definition around 8am ET. */
  @Cron('*/5 * * * *')
  async scheduleRefresh(): Promise<void> {
    if (!this.appConfig.runSchedulers()) return;
    try {
      await this.jobs.enqueueCron(JOBS.dailyContentRefresh, {}, 'cron:dailyContentRefresh', {
        attempts: 2,
        backoff: { type: 'exponential', delay: 60_000 },
      });
    } catch {
      // likely duplicate jobId while previous run is active; treat as no-op
    }
  }

  async runRefreshDailyContent(): Promise<void> {
    await this.dailyContent.refreshForTodayIfNeeded();
  }
}

