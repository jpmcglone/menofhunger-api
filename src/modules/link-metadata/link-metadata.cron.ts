import { Injectable, Logger } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import { LinkMetadataService } from './link-metadata.service';
import { JobsService } from '../jobs/jobs.service';
import { JOBS } from '../jobs/jobs.constants';
import { AppConfigService } from '../app/app-config.service';

@Injectable()
export class LinkMetadataCron {
  private readonly logger = new Logger(LinkMetadataCron.name);

  constructor(
    private readonly linkMetadata: LinkMetadataService,
    private readonly jobs: JobsService,
    private readonly appConfig: AppConfigService,
  ) {}

  @Cron('*/5 * * * *')
  async handleBackfill() {
    try {
      if (!this.appConfig.runSchedulers()) return;
      await this.jobs.enqueueCron(JOBS.linkMetadataBackfill, {}, 'cron:linkMetadataBackfill', {
        attempts: 3,
        backoff: { type: 'exponential', delay: 60_000 },
      });
    } catch (err) {
      // likely duplicate jobId while previous run is active; treat as no-op
      this.logger.debug(`Link metadata backfill enqueue skipped: ${(err as Error).message}`);
    }
  }

  async runHandleBackfill() {
    try {
      const result = await this.linkMetadata.runBackfill();
      if (result.cached > 0) {
        this.logger.log(`Link metadata backfill: ${result.urlsFound} URLs, ${result.cached} newly cached`);
      }
    } catch (err) {
      this.logger.warn(`Link metadata backfill failed: ${(err as Error).message}`);
    }
  }
}
