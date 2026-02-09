import { Injectable, Logger } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import { PrismaService } from '../prisma/prisma.service';

@Injectable()
export class SearchCleanupCron {
  private readonly logger = new Logger(SearchCleanupCron.name);
  private running = false;

  constructor(private readonly prisma: PrismaService) {}

  /** Retention window for `UserSearch` rows. */
  private readonly retentionDays = 90;

  @Cron('0 3 * * *')
  async cleanupUserSearchHistory() {
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

