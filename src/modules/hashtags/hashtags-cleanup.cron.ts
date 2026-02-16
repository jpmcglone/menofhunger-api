import { Injectable, Logger } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import { PrismaService } from '../prisma/prisma.service';
import { JobsService } from '../jobs/jobs.service';
import { JOBS } from '../jobs/jobs.constants';
import { AppConfigService } from '../app/app-config.service';

@Injectable()
export class HashtagsCleanupCron {
  private readonly logger = new Logger(HashtagsCleanupCron.name);
  private running = false;

  constructor(
    private readonly prisma: PrismaService,
    private readonly jobs: JobsService,
    private readonly appConfig: AppConfigService,
  ) {}

  /**
   * Safety net: remove zero-count hashtag rows that may linger due to legacy data or partial failures.
   * Mirrors per-tag cleanup in `PostsService`, but applied globally.
   */
  @Cron('0 5 * * *')
  async cleanupOrphanHashtags() {
    if (!this.appConfig.runSchedulers()) return;
    try {
      await this.jobs.enqueueCron(JOBS.hashtagsCleanup, {}, 'cron:hashtagsCleanup', {
        attempts: 2,
        backoff: { type: 'exponential', delay: 5 * 60_000 },
      });
    } catch {
      // likely duplicate jobId while previous run is active; treat as no-op
    }
  }

  async runCleanupOrphanHashtags() {
    if (this.running) return;
    this.running = true;
    const startedAt = Date.now();
    try {
      const [variants, hashtags] = await this.prisma.$transaction([
        this.prisma.hashtagVariant.deleteMany({ where: { count: { lte: 0 } } }),
        this.prisma.hashtag.deleteMany({ where: { usageCount: { lte: 0 } } }),
      ]);

      const ms = Date.now() - startedAt;
      if ((variants.count ?? 0) > 0 || (hashtags.count ?? 0) > 0) {
        this.logger.log(`Hashtags cleanup: variants=${variants.count} hashtags=${hashtags.count} (${ms}ms)`);
      }
    } catch (err) {
      this.logger.warn(`Hashtags cleanup failed: ${(err as Error).message}`);
    } finally {
      this.running = false;
    }
  }
}

