import { Injectable, Logger } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import { AppConfigService } from '../app/app-config.service';
import { JOBS } from '../jobs/jobs.constants';
import { JobsService } from '../jobs/jobs.service';
import { NewslettersService } from './newsletters.service';

@Injectable()
export class NewslettersCron {
  private readonly logger = new Logger(NewslettersCron.name);

  constructor(
    private readonly newsletters: NewslettersService,
    private readonly jobs: JobsService,
    private readonly appConfig: AppConfigService,
  ) {}

  @Cron('* * * * *')
  async enqueueSweep() {
    if (!this.appConfig.runSchedulers()) return;
    try {
      await this.jobs.enqueueCron(JOBS.newslettersScheduledSweep, {}, 'cron-newslettersScheduledSweep', {
        attempts: 2,
        backoff: { type: 'exponential', delay: 30_000 },
      });
    } catch (err) {
      this.logger.debug(`Newsletter sweep enqueue skipped: ${(err as Error).message}`);
    }
  }

  async runSweep() {
    await this.newsletters.claimDueAndEnqueue();
  }

  async runSend(newsletterId: string) {
    await this.newsletters.runSend(newsletterId);
  }
}
