import { Injectable, Logger } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import { LinkMetadataService } from './link-metadata.service';

@Injectable()
export class LinkMetadataCron {
  private readonly logger = new Logger(LinkMetadataCron.name);

  constructor(private readonly linkMetadata: LinkMetadataService) {}

  @Cron('*/5 * * * *')
  async handleBackfill() {
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
