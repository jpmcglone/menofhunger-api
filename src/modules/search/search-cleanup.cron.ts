import { Injectable, Logger } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import { PrismaService } from '../prisma/prisma.service';
import { JobsService } from '../jobs/jobs.service';
import { JOBS } from '../jobs/jobs.constants';
import { AppConfigService } from '../app/app-config.service';

@Injectable()
export class SearchCleanupCron {
  private readonly logger = new Logger(SearchCleanupCron.name);
  private running = false;

  constructor(
    private readonly prisma: PrismaService,
    private readonly jobs: JobsService,
    private readonly appConfig: AppConfigService,
  ) {}

  /** Retention window for `UserSearch` rows. */
  private readonly retentionDays = 90;

  @Cron('0 3 * * *')
  async cleanupUserSearchHistory() {
    if (!this.appConfig.runSchedulers()) return;
    try {
      await this.jobs.enqueueCron(JOBS.searchCleanup, {}, 'cron:searchCleanup', {
        attempts: 2,
        backoff: { type: 'exponential', delay: 5 * 60_000 },
      });
    } catch {
      // likely duplicate jobId while previous run is active; treat as no-op
    }
  }

  async runCleanupUserSearchHistory() {
    if (this.running) return;
    this.running = true;
    const startedAt = Date.now();
    try {
      const cutoff = new Date(Date.now() - this.retentionDays * 24 * 60 * 60 * 1000);
      const deleted = await this.prisma.userSearch.deleteMany({
        where: { createdAt: { lt: cutoff } },
      });
      const ms = Date.now() - startedAt;
      if ((deleted.count ?? 0) > 0) {
        this.logger.log(`Search cleanup: userSearches=${deleted.count} retentionDays=${this.retentionDays} (${ms}ms)`);
      }
    } catch (err) {
      this.logger.warn(`Search cleanup failed: ${(err as Error).message}`);
    } finally {
      this.running = false;
    }
  }
}

