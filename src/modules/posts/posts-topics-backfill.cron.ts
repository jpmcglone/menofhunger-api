import { Injectable, Logger } from '@nestjs/common';
import { clampLimit } from '../../common/pagination/page';
import { Cron } from '@nestjs/schedule';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { inferTopicsFromText } from '../../common/topics/topic-utils';
import { JobsService } from '../jobs/jobs.service';
import { JOBS } from '../jobs/jobs.constants';
import { AppConfigService } from '../app/app-config.service';
import { createdAtIdBefore } from '../../common/pagination/created-at-id-cursor';
import { NOT_DELETED } from '../../common/prisma/where';

type BackfillPostRow = {
  id: string;
  body: string | null;
  hashtags: string[];
  parentId: string | null;
  rootId: string | null;
  createdAt: Date;
};
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
      await this.jobs.enqueueCron(JOBS.postsTopicsBackfill, {}, 'cron-postsTopicsBackfill', {
        attempts: 2,
        backoff: { type: 'exponential', delay: 60_000 },
      });
    } catch {
      // likely duplicate jobId while previous run is active; treat as no-op
    }
  }

  /**
   * Infer topics for posts.
   *
   * - Default / cron: one batch of posts with empty `topics`.
   * - Admin one-shot: pass `wipeExisting: true` (and optionally `runUntilEmpty: true`)
   *   to rebuild every post in the lookback window via cursor batches.
   *
   * Deploy invoke (admin):
   *   POST /admin/jobs/posts-topics-backfill
   *   { "wipeExisting": true, "runUntilEmpty": true, "batchSize": 500, "lookbackDays": 3650 }
   */
  async runBackfill(opts?: {
    wipeExisting?: boolean;
    batchSize?: number;
    lookbackDays?: number;
    runUntilEmpty?: boolean;
  }) {
    if (this.running) return;
    this.running = true;
    const startedAt = Date.now();
    try {
      const wipeExisting = Boolean(opts?.wipeExisting);
      // Wipe rebuilds every row — always drain. Empty-topic fills drain when asked.
      const runUntilEmpty = Boolean(opts?.runUntilEmpty) || wipeExisting;
      const lookbackDays = clampLimit(opts?.lookbackDays, { default: 3650, max: 10_000 });
      const batchSize = Math.max(10, Math.min(5_000, Math.floor(opts?.batchSize ?? 200)));
      const minCreatedAt = new Date(Date.now() - lookbackDays * 24 * 60 * 60 * 1000);
      const maxBatches = runUntilEmpty ? 50 : 1;

      let cursor: { createdAt: Date; id: string } | null = null;
      let total = 0;

      for (let batch = 0; batch < maxBatches; batch++) {
        const cursorWhere: Prisma.PostWhereInput = cursor
          ? createdAtIdBefore({ createdAt: cursor.createdAt, id: cursor.id })
          : {};

        const rows: BackfillPostRow[] = await this.prisma.post.findMany({
          where: {
            ...NOT_DELETED,
            createdAt: { gte: minCreatedAt },
            ...(wipeExisting ? {} : { topics: { equals: [] }, topicsClassifiedAt: null }),
            ...cursorWhere,
          },
          select: { id: true, body: true, hashtags: true, parentId: true, rootId: true, createdAt: true },
          orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
          take: batchSize,
        });

        if (rows.length === 0) break;

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

        const updates = rows.map((p) => {
          const hashtags = p.hashtags ?? [];
          const topics = inferTopicsFromText(p.body ?? '', {
            hashtags,
            relatedTopics: [...new Set([
              ...(topicsById.get(p.parentId ?? '') ?? []),
              ...(topicsById.get(p.rootId ?? '') ?? []),
            ])].filter(Boolean),
          });
          return {
            id: p.id, body: p.body, hashtags, topics,
            thin: hashtags.length === 0 && (p.body ?? '').trim().length < 24 && topics.length === 0,
          };
        });
        // One bounded update, not one round trip (and full Post RETURNING) per row.
        // Preserve concurrent edits/classifications while the batch was inferred.
        total += await this.prisma.$executeRaw`
          UPDATE "Post" p SET topics = ARRAY(SELECT jsonb_array_elements_text(v.topics)),
            "topicsClassifiedAt" = CASE WHEN v.thin THEN NOW()
              WHEN ${wipeExisting} THEN NULL ELSE p."topicsClassifiedAt" END
          FROM jsonb_to_recordset(${JSON.stringify(updates)}::jsonb)
            AS v(id text, body text, hashtags jsonb, topics jsonb, thin boolean)
          WHERE p.id = v.id AND p."deletedAt" IS NULL
            AND p.body IS NOT DISTINCT FROM v.body
            AND p.hashtags = ARRAY(SELECT jsonb_array_elements_text(v.hashtags))
            AND (${wipeExisting} OR (p.topics = ARRAY[]::text[] AND p."topicsClassifiedAt" IS NULL))
        `;

        const last: BackfillPostRow = rows[rows.length - 1]!;
        cursor = { createdAt: last.createdAt, id: last.id };

        if (!runUntilEmpty) break;
        if (rows.length < batchSize) break;
      }

      if (total > 0) {
        const ms = Date.now() - startedAt;
        this.logger.log(
          `${wipeExisting ? 'Rebuilt' : 'Backfilled'} topics for ${total} posts (${ms}ms)`,
        );
      }

      // Enrich unclassified posts with Luna, including keyword-tagged posts (one bounded batch per tick).
      try {
        await this.jobs.enqueueCron(
          JOBS.postsTopicsAiClassify,
          { batchSize: 20 },
          'cron-postsTopicsAiClassify',
          { attempts: 2, backoff: { type: 'exponential', delay: 60_000 } },
        );
      } catch {
        // Duplicate while a classify batch is already queued.
      }
    } catch (err) {
      this.logger.warn(`Topics backfill failed: ${(err as Error).message}`);
    } finally {
      this.running = false;
    }
  }
}
