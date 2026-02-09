import { Injectable, Logger } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import { PrismaService } from '../prisma/prisma.service';

@Injectable()
export class HashtagsCleanupCron {
  private readonly logger = new Logger(HashtagsCleanupCron.name);
  private running = false;

  constructor(private readonly prisma: PrismaService) {}

  /**
   * Safety net: remove zero-count hashtag rows that may linger due to legacy data or partial failures.
   * Mirrors per-tag cleanup in `PostsService`, but applied globally.
   */
  @Cron('0 5 * * *')
  async cleanupOrphanHashtags() {
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

