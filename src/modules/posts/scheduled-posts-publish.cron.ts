import { Injectable, Logger } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import { JobsService } from '../jobs/jobs.service';
import { JOBS } from '../jobs/jobs.constants';
import { AppConfigService } from '../app/app-config.service';
import { ScheduledPostsService } from './scheduled-posts.service';

@Injectable()
export class ScheduledPostsPublishCron {
  private readonly logger = new Logger(ScheduledPostsPublishCron.name);

  constructor(
    private readonly scheduledPosts: ScheduledPostsService,
    private readonly jobs: JobsService,
    private readonly appConfig: AppConfigService,
  ) {}

  @Cron('* * * * *')
  async enqueueSweep() {
    if (!this.appConfig.runSchedulers()) return;
    try {
      await this.jobs.enqueueCron(JOBS.postsScheduledPublishSweep, {}, 'cron-postsScheduledPublishSweep', {
        attempts: 2,
        backoff: { type: 'exponential', delay: 30_000 },
      });
    } catch (err) {
      this.logger.debug(`Scheduled posts sweep enqueue skipped: ${(err as Error).message}`);
    }
  }

  async runPublishDue() {
    await this.scheduledPosts.publishDue();
  }
}
