import { ConflictException, Injectable, Logger } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { createdAtIdCursorWhere } from '../../common/pagination/created-at-id-cursor';
import { parseHashtagTokensFromText } from '../../common/hashtags/hashtag-regex';
import { HashtagsTrendingScoreCron } from '../hashtags/hashtags-trending-score.cron';

type BackfillStatusDto = {
  id: string;
  status: string;
  cursor: string | null;
  processedPosts: number;
  updatedPosts: number;
  resetDone: boolean;
  startedAt: string;
  finishedAt: string | null;
  lastError: string | null;
  updatedAt: string;
};

@Injectable()
export class AdminHashtagsService {
  private readonly logger = new Logger(AdminHashtagsService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly hashtagTrendingCron: HashtagsTrendingScoreCron,
  ) {}

  async getBackfillStatus(): Promise<{ data: BackfillStatusDto | null }> {
    const run = await this.prisma.hashtagBackfillRun.findFirst({
      orderBy: [{ updatedAt: 'desc' }, { id: 'desc' }],
    });
    if (!run) return { data: null };
    return {
      data: {
        id: run.id,
        status: run.status,
        cursor: run.cursor ?? null,
        processedPosts: run.processedPosts ?? 0,
        updatedPosts: run.updatedPosts ?? 0,
        resetDone: Boolean(run.resetDone),
        startedAt: run.startedAt.toISOString(),
        finishedAt: run.finishedAt ? run.finishedAt.toISOString() : null,
        lastError: run.lastError ? String(run.lastError) : null,
        updatedAt: run.updatedAt.toISOString(),
      },
    };
  }

  async runBackfillBatch(params: {
    runId: string | null;
    cursor: string | null;
    batchSize: number;
    reset: boolean;
  }): Promise<{
    data: {
      runId: string;
      processedPosts: number;
      updatedPosts: number;
      nextCursor: string | null;
      done: boolean;
    };
  }> {
    const batchSize = Math.max(10, Math.min(5_000, Math.floor(params.batchSize || 500)));

    // One request = one interactive transaction so advisory_xact_lock is safe (single connection).
    const res = await this.prisma.$transaction(async (tx) => {
      // Ensure only one backfill batch runs at a time.
      const lockKey = 982_341_771;
      const lockedRows = await tx.$queryRaw<Array<{ locked: boolean }>>(
        Prisma.sql`SELECT pg_try_advisory_xact_lock(${lockKey}) AS locked`,
      );
      const locked = Boolean(lockedRows?.[0]?.locked);
      if (!locked) throw new ConflictException('Hashtag backfill is already running.');

      const now = new Date();

      const run =
        params.runId
          ? await tx.hashtagBackfillRun.findUnique({ where: { id: params.runId } })
          : await tx.hashtagBackfillRun.create({
              data: { status: 'running', cursor: null, processedPosts: 0, updatedPosts: 0, resetDone: false, startedAt: now },
            });

      if (!run) throw new ConflictException('Backfill run not found.');
      if (run.status !== 'running') {
        throw new ConflictException(`Backfill run is not running (status=${run.status}).`);
      }

      // Reset mode: only allowed when starting a run (or when run.resetDone is false).
      const shouldReset = Boolean(params.reset) && !run.resetDone;
      if (shouldReset) {
        await tx.hashtagVariant.deleteMany({});
        await tx.hashtag.deleteMany({});
        await tx.hashtagBackfillRun.update({
          where: { id: run.id },
          data: { resetDone: true, processedPosts: 0, updatedPosts: 0, cursor: null, lastError: null },
        });
      }

      const effectiveCursor = (params.cursor ?? run.cursor ?? null) ? String(params.cursor ?? run.cursor) : null;

      const cursorWhere = await createdAtIdCursorWhere({
        cursor: effectiveCursor,
        lookup: async (id) =>
          await tx.post.findUnique({
            where: { id },
            select: { id: true, createdAt: true },
          }),
      });

      const rows = await tx.post.findMany({
        where: {
          AND: [
            { deletedAt: null },
            ...(cursorWhere ? [cursorWhere] : []),
          ],
        },
        orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
        take: batchSize + 1,
        select: { id: true, body: true, hashtags: true, hashtagCasings: true },
      });

      const batch = rows.slice(0, batchSize);
      const hasMore = rows.length > batchSize;
      const nextCursor = hasMore ? (batch[batch.length - 1]?.id ?? null) : null;

      let processedPosts = 0;
      let updatedPosts = 0;

      const tagInc = new Map<string, number>();
      const variantInc = new Map<string, { tag: string; variant: string; inc: number }>();

      for (const p of batch) {
        processedPosts += 1;
        const tokensRaw = parseHashtagTokensFromText(p.body ?? '');
        const tokens = tokensRaw
          .map((t) => ({ tag: (t.tag ?? '').trim().toLowerCase(), variant: (t.variant ?? '').trim() }))
          .filter((t) => Boolean(t.tag && t.variant));
        tokens.sort((a, b) => a.tag.localeCompare(b.tag) || a.variant.localeCompare(b.variant));

        const nextHashtags = tokens.map((t) => t.tag);
        const nextCasings = tokens.map((t) => t.variant);

        const curHashtags = Array.isArray((p as any).hashtags) ? ((p as any).hashtags as string[]) : [];
        const curCasings = Array.isArray((p as any).hashtagCasings) ? ((p as any).hashtagCasings as string[]) : [];

        const changed =
          curHashtags.length !== nextHashtags.length ||
          curCasings.length !== nextCasings.length ||
          curHashtags.some((v, i) => v !== nextHashtags[i]) ||
          curCasings.some((v, i) => v !== nextCasings[i]);

        if (changed) {
          updatedPosts += 1;
          await tx.post.update({
            where: { id: p.id },
            data: { hashtags: nextHashtags, hashtagCasings: nextCasings },
          });
        }

        // Rebuild counts based on tokens (one per unique lowercase tag per post).
        for (const tok of tokens) {
          tagInc.set(tok.tag, (tagInc.get(tok.tag) ?? 0) + 1);
          const key = `${tok.tag}\n${tok.variant}`;
          const hit = variantInc.get(key);
          if (hit) hit.inc += 1;
          else variantInc.set(key, { tag: tok.tag, variant: tok.variant, inc: 1 });
        }
      }

      for (const [tag, inc] of tagInc) {
        await tx.hashtag.upsert({
          where: { tag },
          create: { tag, usageCount: inc },
          update: { usageCount: { increment: inc } },
        });
      }
      for (const { tag, variant, inc } of variantInc.values()) {
        await tx.hashtagVariant.upsert({
          where: { tag_variant: { tag, variant } },
          create: { tag, variant, count: inc },
          update: { count: { increment: inc } },
        });
      }

      const done = !hasMore || batch.length === 0;
      await tx.hashtagBackfillRun.update({
        where: { id: run.id },
        data: {
          cursor: nextCursor,
          processedPosts: { increment: processedPosts },
          updatedPosts: { increment: updatedPosts },
          ...(done ? { status: 'done', finishedAt: new Date() } : {}),
          lastError: null,
        },
      });

      return {
        data: {
          runId: run.id,
          processedPosts: (run.processedPosts ?? 0) + processedPosts,
          updatedPosts: (run.updatedPosts ?? 0) + updatedPosts,
          nextCursor,
          done,
        },
      };
    }, { timeout: 120_000 });

    // When a backfill run finishes, refresh hashtag trending snapshots immediately so the UI updates right away.
    if (res?.data?.done) {
      try {
        await this.hashtagTrendingCron.refreshTrendingHashtagSnapshots();
      } catch (err) {
        this.logger.warn(`Hashtag trending refresh after backfill failed: ${(err as Error).message}`);
      }
    }

    return res;
  }
}

