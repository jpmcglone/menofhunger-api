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
  async backfill() {
    if (this.running) return;
    this.running = true;
    const startedAt = Date.now();
    try {
      const lookbackDays = 60;
      const minCreatedAt = new Date(Date.now() - lookbackDays * 24 * 60 * 60 * 1000);

      const rows = await this.prisma.post.findMany({
        where: {
          deletedAt: null,
          createdAt: { gte: minCreatedAt },
          topics: { equals: [] },
        },
        select: { id: true, body: true },
        orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
        take: 200,
      });

      if (rows.length === 0) return;

      await this.prisma.$transaction(
        rows.map((p) =>
          this.prisma.post.update({
            where: { id: p.id },
            data: { topics: inferTopicsFromText(p.body ?? '') },
          }),
        ),
      );

      const ms = Date.now() - startedAt;
      this.logger.log(`Backfilled topics for ${rows.length} posts (${ms}ms)`);
    } catch (err) {
      this.logger.warn(`Topics backfill failed: ${(err as Error).message}`);
    } finally {
      this.running = false;
    }
  }
}

