import { Injectable, Logger } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import { AppConfigService } from '../app/app-config.service';
import { JobsService } from '../jobs/jobs.service';
import { JOBS } from '../jobs/jobs.constants';
import { AdminIntroBriefService } from './admin-intro-brief.service';

@Injectable()
export class AdminIntroBriefCron {
  private readonly logger = new Logger(AdminIntroBriefCron.name);

  constructor(
    private readonly appConfig: AppConfigService,
    private readonly jobs: JobsService,
    private readonly briefs: AdminIntroBriefService,
  ) {}

  /** Monday 14:00 UTC — after Sunday US evening, before the week starts. */
  @Cron('0 14 * * 1')
  async weekly() {
    if (!this.appConfig.runSchedulers()) return;
    try {
      await this.jobs.enqueueCron(JOBS.adminIntroBrief, {}, 'cron-adminIntroBrief', {
        attempts: 2,
        backoff: { type: 'exponential', delay: 10 * 60_000 },
      });
    } catch (err) {
      this.logger.warn(
        `[admin-intro-brief] cron enqueue failed: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }

  async runGenerate(): Promise<void> {
    await this.briefs.generate();
  }
}
