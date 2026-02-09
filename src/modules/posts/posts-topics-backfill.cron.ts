import { Injectable, Logger } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import { PrismaService } from '../prisma/prisma.service';
import { inferTopicsFromText } from '../../common/topics/topic-utils';

@Injectable()
export class PostsTopicsBackfillCron {
  private readonly logger = new Logger(PostsTopicsBackfillCron.name);
  private running = false;

  constructor(private readonly prisma: PrismaService) {}

  /**
   * Best-effort backfill for older posts created before we stored topics.
   * Small bounded batches; safe to run repeatedly.
   */
  @Cron('*/15 * * * *')
  async backfill(opts?: { wipeExisting?: boolean; batchSize?: number; lookbackDays?: number }) {
    if (this.running) return;
    this.running = true;
    const startedAt = Date.now();
    try {
      const wipeExisting = Boolean(opts?.wipeExisting);
      const lookbackDays = Math.max(1, Math.min(10_000, Math.floor(opts?.lookbackDays ?? 3650)));
      const batchSize = Math.max(10, Math.min(5_000, Math.floor(opts?.batchSize ?? 200)));
      const minCreatedAt = new Date(Date.now() - lookbackDays * 24 * 60 * 60 * 1000);

      const rows = await this.prisma.post.findMany({
        where: {
          deletedAt: null,
          createdAt: { gte: minCreatedAt },
          ...(wipeExisting ? {} : { topics: { equals: [] } }),
        },
        select: { id: true, body: true, hashtags: true },
        orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
        take: batchSize,
      });

      if (rows.length === 0) return;

      await this.prisma.$transaction(
        rows.map((p) =>
          this.prisma.post.update({
            where: { id: p.id },
            data: { topics: inferTopicsFromText(p.body ?? '', p.hashtags ?? []) },
          }),
        ),
      );

      const ms = Date.now() - startedAt;
      this.logger.log(
        `${wipeExisting ? 'Rebuilt' : 'Backfilled'} topics for ${rows.length} posts (${ms}ms)`,
      );
    } catch (err) {
      this.logger.warn(`Topics backfill failed: ${(err as Error).message}`);
    } finally {
      this.running = false;
    }
  }
}

