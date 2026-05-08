import { Injectable, Logger } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import { AppConfigService } from '../../app/app-config.service';
import { JobsService } from '../../jobs/jobs.service';
import { JOBS } from '../../jobs/jobs.constants';

/**
 * Daily refresh of Marv's per-user context cards.
 *
 * The cron emits a single BullMQ job; `JobsProcessor` then drives a batched
 * scan of stale cards via `MarvinContextCardService`. We don't refresh all
 * users in a single shot — that would be both expensive (N OpenAI calls) and
 * unnecessary, since each card is only consulted when Marv is actually asked
 * about that user.
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
