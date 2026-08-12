import { Injectable, Logger } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import { AppConfigService } from '../../app/app-config.service';
import { JobsService } from '../../jobs/jobs.service';
import { JOBS } from '../../jobs/jobs.constants';

/**
 * Daily scan for Marv context cards that need a refresh.
 *
 * Activity-based: users with no card, or with new public posts/articles since
 * the last write. The cron emits one BullMQ job; the processor then refreshes
 * a bounded batch. We don't refresh all users in a single shot.
 */
@Injectable()
export class MarvinContextCardsCron {
  private readonly logger = new Logger(MarvinContextCardsCron.name);

  constructor(
    private readonly appConfig: AppConfigService,
    private readonly jobs: JobsService,
  ) {}

  /** 04:30 UTC daily — chosen to land outside US-east peak hours. */
  @Cron('30 4 * * *')
  async dailyRefresh() {
    if (!this.appConfig.runSchedulers()) return;
    if (!this.appConfig.marvBot().enabled) return;
    try {
      await this.jobs.enqueueCron(
        JOBS.marvinContextCardsRefresh,
        {},
        'cron-marvinContextCardsRefresh',
        {
          attempts: 2,
          backoff: { type: 'exponential', delay: 5 * 60_000 },
        },
      );
    } catch (err) {
      this.logger.warn(
        `[marv] context-cards cron enqueue failed: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }
}
