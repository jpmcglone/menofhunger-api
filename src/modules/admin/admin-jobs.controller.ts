import { Body, Controller, Get, Param, Post, Query, UseGuards } from '@nestjs/common';
import { z } from 'zod';
import { AdminGuard } from './admin.guard';
import { AdminHashtagsService } from './admin-hashtags.service';
import { TickerIngestCron } from '../cashtags/ticker-ingest.cron';
import { AdminMaintenanceService } from './admin-maintenance.service';
import { JobsService } from '../jobs/jobs.service';
import { JobsStatusService } from '../jobs/jobs-status.service';
import { JOBS } from '../jobs/jobs.constants';
import { queryBoolean } from '../../common/validation/query-boolean';

const hashtagBackfillSchema = z.object({
  /** Existing run id. If omitted, a new run is started. */
  runId: z.string().trim().min(1).optional(),
  /** Cursor post id (createdAt/id cursor). If omitted, uses stored run cursor. */
  cursor: z.string().trim().min(1).optional(),
  /** Batch size (posts per request). */
  batchSize: z.coerce.number().int().min(10).max(5_000).optional(),
  /** When true and starting a new run, reset hashtag tables before scanning. */
  reset: queryBoolean().optional(),
});

const postsTopicsBackfillSchema = z.object({
  /** When true, recompute topics even if already set (drains the lookback window). */
  wipeExisting: queryBoolean().optional(),
  /** When true, loop batches until no matching posts remain (implied by wipeExisting). */
  runUntilEmpty: queryBoolean().optional(),
  /** Batch size (posts per batch). */
  batchSize: z.coerce.number().int().min(10).max(5_000).optional(),
  /** How far back to scan for posts. */
  lookbackDays: z.coerce.number().int().min(1).max(10_000).optional(),
});

const normalizeTopicsSchema = z.object({
  /** When true, normalize users' interests arrays. */
  users: queryBoolean().optional(),
  /** When true, normalize TopicFollow.topic values. */
  follows: queryBoolean().optional(),
});

@UseGuards(AdminGuard)
@Controller('admin/jobs')
export class AdminJobsController {
  constructor(
    private readonly maintenance: AdminMaintenanceService,
    private readonly adminHashtags: AdminHashtagsService,
    private readonly jobs: JobsService,
    private readonly jobsStatus: JobsStatusService,
    private readonly tickerIngest: TickerIngestCron,
  ) {}

  @Post('tickers/ingest')
  async runTickerIngest() {
    const result = await this.tickerIngest.runIngest();
    return { data: { ok: true, ...result } };
  }

  @Get('hashtags/backfill')
  async hashtagBackfillStatus() {
    return { data: await this.adminHashtags.getBackfillStatus() };
  }

  @Post('hashtags/backfill')
  async hashtagBackfill(@Body() body: unknown) {
    const parsed = hashtagBackfillSchema.parse(body ?? {});
    return {
      data: await this.adminHashtags.runBackfillBatch({
      runId: parsed.runId ?? null,
      cursor: parsed.cursor ?? null,
      batchSize: parsed.batchSize ?? 500,
      reset: Boolean(parsed.reset),
      }),
    };
  }

  @Get('status/:jobId')
  async jobStatus(@Param('jobId') jobId: string) {
    return { data: await this.jobsStatus.getStatus(String(jobId ?? '').trim()) };
  }

  /**
   * Worker liveness + backlog depth for every queue.
   *
   * Answers "is anything actually draining this queue" permanently, which matters most for
   * `moh_side_effects` — every notification and push in the app flows through it, and a worker
   * that never started looks identical to a quiet app from the outside.
   */
  @Get('queues')
  async queuesHealth() {
    return { data: await this.jobsStatus.getQueuesHealth() };
  }

  @Post('auth-cleanup')
  async runAuthCleanup(@Query('wait') wait?: string) {
    const job = await this.jobs.enqueue(JOBS.authCleanup, {}, { removeOnComplete: true, removeOnFail: false });
    const shouldWait = ['1', 'true', 'yes', 'on'].includes(String(wait ?? '').trim().toLowerCase());
    if (shouldWait) {
      const res = await this.jobsStatus.waitForCompletion(String(job.id), 25_000);
      return { data: { ok: res.ok, jobId: String(job.id), result: res.ok ? res.result : null, waitError: res.ok ? null : res.reason } };
    }
    return { data: { ok: true, jobId: String(job.id) } };
  }

  @Post('search-cleanup')
  async runSearchCleanup(@Query('wait') wait?: string) {
    const job = await this.jobs.enqueue(JOBS.searchCleanup, {}, { removeOnComplete: true, removeOnFail: false });
    const shouldWait = ['1', 'true', 'yes', 'on'].includes(String(wait ?? '').trim().toLowerCase());
    if (shouldWait) {
      const res = await this.jobsStatus.waitForCompletion(String(job.id), 25_000);
      return { data: { ok: res.ok, jobId: String(job.id), result: res.ok ? res.result : null, waitError: res.ok ? null : res.reason } };
    }
    return { data: { ok: true, jobId: String(job.id) } };
  }

  @Post('notifications-cleanup')
  async runNotificationsCleanup() {
    const job = await this.jobs.enqueue(JOBS.notificationsCleanup, {}, { removeOnComplete: true, removeOnFail: false });
    return { data: { ok: true, jobId: String(job.id) } };
  }

  /**
   * Retroactively deduplicate word_of_the_day and quote_of_the_day notifications:
   * keep only the most-recent row per (user, kind) and fix the bell counter.
   * Safe to run multiple times (idempotent). Going forward the fan-out does this
   * automatically, so this endpoint is mainly useful as a one-off backfill.
   */
  @Post('notifications-dedupe-daily-content')
  async runDailyContentDeduplication() {
    return { data: { ok: true, ...(await this.maintenance.dedupeDailyContentNotifications()) } };
  }

  @Post('notifications-orphan-cleanup')
  async runNotificationsOrphanCleanup() {
    const job = await this.jobs.enqueue(JOBS.notificationsOrphanCleanup, {}, { removeOnComplete: true, removeOnFail: false });
    return { data: { ok: true, jobId: String(job.id) } };
  }

  @Post('hashtags-cleanup')
  async runHashtagsCleanup() {
    const job = await this.jobs.enqueue(JOBS.hashtagsCleanup, {}, { removeOnComplete: true, removeOnFail: false });
    return { data: { ok: true, jobId: String(job.id) } };
  }

  /**
   * One-shot after deploy (rebuild topics for discover-more):
   * POST { wipeExisting: true, runUntilEmpty: true, batchSize: 500, lookbackDays: 3650 }
   */
  @Post('posts-topics-backfill')
  async runPostsTopicsBackfill(@Body() body: unknown) {
    const parsed = postsTopicsBackfillSchema.parse(body ?? {});
    const job = await this.jobs.enqueue(
      JOBS.postsTopicsBackfill,
      {
      wipeExisting: Boolean(parsed.wipeExisting),
      runUntilEmpty: Boolean(parsed.runUntilEmpty),
      batchSize: parsed.batchSize ?? undefined,
      lookbackDays: parsed.lookbackDays ?? undefined,
      },
      { removeOnComplete: true, removeOnFail: false },
    );
    return { data: { ok: true, jobId: String(job.id) } };
  }

  @Post('posts-topics-ai-classify')
  async runPostsTopicsAiClassify(@Body() body: unknown) {
    const parsed = postsTopicsBackfillSchema.pick({ runUntilEmpty: true, batchSize: true }).parse(body ?? {});
    const job = await this.jobs.enqueue(
      JOBS.postsTopicsAiClassify,
      {
        runUntilEmpty: Boolean(parsed.runUntilEmpty),
        batchSize: parsed.batchSize ?? 20,
      },
      { removeOnComplete: true, removeOnFail: false },
    );
    return { data: { ok: true, jobId: String(job.id) } };
  }

  @Post('topics-normalize')
  async normalizeTopicsEverywhere(@Body() body: unknown) {
    const parsed = normalizeTopicsSchema.parse(body ?? {});
    await this.maintenance.normalizeTopics({
      normalizeUsers: parsed.users !== false,
      normalizeFollows: parsed.follows !== false,
    });
    return { data: { ok: true } };
  }

  @Post('posts-popular-refresh')
  async runPostsPopularRefresh() {
    const job = await this.jobs.enqueue(JOBS.postsPopularScoreRefresh, {}, { removeOnComplete: true, removeOnFail: false });
    return { data: { ok: true, jobId: String(job.id) } };
  }

  @Post('hashtags-trending-refresh')
  async runHashtagsTrendingRefresh() {
    const job = await this.jobs.enqueue(JOBS.hashtagsTrendingScoreRefresh, {}, { removeOnComplete: true, removeOnFail: false });
    return { data: { ok: true, jobId: String(job.id) } };
  }

  @Post('link-metadata-backfill')
  async runLinkMetadataBackfill() {
    const job = await this.jobs.enqueue(JOBS.linkMetadataBackfill, {}, { removeOnComplete: true, removeOnFail: false });
    return { data: { ok: true, jobId: String(job.id) } };
  }

  /**
   * Recompute entitlements for every user who has premium/premiumPlus set in the
   * database but has no active Stripe subscription and no active grants. These are
   * legacy users whose premium flag was set directly in the DB before the entitlement
   * system existed. The recompute will clear the stale flag down to verified.
   */
  @Post('entitlements-backfill')
  async runEntitlementsBackfill() {
    return { data: { ok: true, ...(await this.maintenance.backfillEntitlements()) } };
  }

  /**
   * Recompute checkinStreakDays, longestStreakDays, and lastCheckinDayKey for every
   * user by walking their check-in history (same rule as live streak awarding).
   * Useful to backfill users whose streak fields are stale/missing.
   *
   * The nightly streak-reset cron will still zero out stale current streaks after
   * this runs — no double-handling needed.
   */
  @Post('streaks-backfill')
  async runStreaksBackfill() {
    return { data: { ok: true, ...(await this.maintenance.backfillStreaks()) } };
  }

  /**
   * Emergency/admin utility: reset all user coin balances to a fixed baseline.
   * Useful when transitioning coin economics to a fully grant-driven model.
   */
  @Post('coins-reset')
  async runCoinsReset() {
    return { data: { ok: true, ...(await this.maintenance.resetCoins()) } };
  }
}

