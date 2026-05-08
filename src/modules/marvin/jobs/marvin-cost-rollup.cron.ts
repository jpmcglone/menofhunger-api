import { Injectable, Logger } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import { AppConfigService } from '../../app/app-config.service';
import { JobsService } from '../../jobs/jobs.service';
import { JOBS } from '../../jobs/jobs.constants';

/**
 * Daily Marv cost rollup cron. Aggregates `MarvinUsageEvent` rows into
 * `MarvinCostRollup` so the admin page can render top-spenders and 7d/30d
 * totals without scanning the raw event stream.
 */
@Injectable()
export class MarvinCostRollupCron {
  private readonly logger = new Logger(MarvinCostRollupCron.name);

  constructor(
    private readonly appConfig: AppConfigService,
    private readonly jobs: JobsService,
  ) {}

  /** 02:15 UTC daily — runs after most US-based traffic but before EU peak. */
  @Cron('15 2 * * *')
  async dailyRollup() {
    if (!this.appConfig.runSchedulers()) return;
    if (!this.appConfig.marvBot().enabled) return;
    try {
      await this.jobs.enqueueCron(JOBS.marvinCostRollup, {}, 'cron-marvinCostRollup', {
        attempts: 2,
        backoff: { type: 'exponential', delay: 5 * 60_000 },
      });
    } catch (err) {
      this.logger.warn(
        `[marv] cost-rollup cron enqueue failed: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }
}
