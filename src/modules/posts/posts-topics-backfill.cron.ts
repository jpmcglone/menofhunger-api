import { Injectable, Logger } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import { PrismaService } from '../prisma/prisma.service';
import { inferTopicsFromText } from '../../common/topics/topic-utils';
import { JobsService } from '../jobs/jobs.service';
import { JOBS } from '../jobs/jobs.constants';
import { AppConfigService } from '../app/app-config.service';

@Injectable()
export class PostsTopicsBackfillCron {
  private readonly logger = new Logger(PostsTopicsBackfillCron.name);
  private running = false;

  constructor(
    private readonly prisma: PrismaService,
    private readonly jobs: JobsService,
    private readonly appConfig: AppConfigService,
  ) {}

  /**
   * Best-effort backfill for older posts created before we stored topics.
   * Small bounded batches; safe to run repeatedly.
   */
  @Cron('*/15 * * * *')
  async backfill() {
    if (!this.appConfig.runSchedulers()) return;
    // Cron tick should enqueue only; opts are respected for admin-triggered runs via enqueue.
    try {
      await this.jobs.enqueueCron(JOBS.postsTopicsBackfill, {}, 'cron:postsTopicsBackfill', {
        attempts: 2,
        backoff: { type: 'exponential', delay: 60_000 },
      });
    } catch {
      // likely duplicate jobId while previous run is active; treat as no-op
    }
  }

  async runBackfill(opts?: { wipeExisting?: boolean; batchSize?: number; lookbackDays?: number }) {
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
        select: { id: true, body: true, hashtags: true, parentId: true, rootId: true },
        orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
        take: batchSize,
      });

      if (rows.length === 0) return;

      // Reply tie-breaker: prefetch parent/root topics for this batch.
      const refIds = new Set<string>();
      for (const r of rows) {
        if (r.parentId) refIds.add(r.parentId);
        if (r.rootId) refIds.add(r.rootId);
      }
      const refRows = refIds.size
        ? await this.prisma.post.findMany({
            where: { id: { in: Array.from(refIds) } },
            select: { id: true, topics: true },
          })
        : [];
      const topicsById = new Map<string, string[]>(
        refRows.map((p) => [p.id, (Array.isArray(p.topics) ? (p.topics as string[]) : [])] as const),
      );

      await this.prisma.$transaction(
        rows.map((p) =>
          this.prisma.post.update({
            where: { id: p.id },
            data: {
              topics: inferTopicsFromText(p.body ?? '', {
                hashtags: p.hashtags ?? [],
                relatedTopics: Array.from(
                  new Set([...(topicsById.get(p.parentId ?? '') ?? []), ...(topicsById.get(p.rootId ?? '') ?? [])]),
                ).filter(Boolean),
              }),
            },
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

