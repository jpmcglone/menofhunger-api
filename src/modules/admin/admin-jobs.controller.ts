import { Body, Controller, Get, Param, Post, Query, UseGuards } from '@nestjs/common';
import { z } from 'zod';
import { AdminGuard } from './admin.guard';
import { AdminHashtagsService } from './admin-hashtags.service';
import { canonicalizeTopicValue } from '../../common/topics/topic-utils';
import { PrismaService } from '../prisma/prisma.service';
import { JobsService } from '../jobs/jobs.service';
import { JobsStatusService } from '../jobs/jobs-status.service';
import { JOBS } from '../jobs/jobs.constants';
import { EntitlementService } from '../billing/entitlement.service';
import { easternDayKey } from '../../common/time/eastern-day-key';

const hashtagBackfillSchema = z.object({
  /** Existing run id. If omitted, a new run is started. */
  runId: z.string().trim().min(1).optional(),
  /** Cursor post id (createdAt/id cursor). If omitted, uses stored run cursor. */
  cursor: z.string().trim().min(1).optional(),
  /** Batch size (posts per request). */
  batchSize: z.coerce.number().int().min(10).max(5_000).optional(),
  /** When true and starting a new run, reset hashtag tables before scanning. */
  reset: z.coerce.boolean().optional(),
});

const postsTopicsBackfillSchema = z.object({
  /** When true, recompute topics even if already set. */
  wipeExisting: z.coerce.boolean().optional(),
  /** Batch size (posts per run). */
  batchSize: z.coerce.number().int().min(10).max(5_000).optional(),
  /** How far back to scan for posts. */
  lookbackDays: z.coerce.number().int().min(1).max(10_000).optional(),
});

const normalizeTopicsSchema = z.object({
  /** When true, normalize users' interests arrays. */
  users: z.coerce.boolean().optional(),
  /** When true, normalize TopicFollow.topic values. */
  follows: z.coerce.boolean().optional(),
});

@UseGuards(AdminGuard)
@Controller('admin/jobs')
export class AdminJobsController {
  constructor(
    private readonly prisma: PrismaService,
    private readonly adminHashtags: AdminHashtagsService,
    private readonly jobs: JobsService,
    private readonly jobsStatus: JobsStatusService,
    private readonly entitlement: EntitlementService,
  ) {}

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

  @Post('posts-topics-backfill')
  async runPostsTopicsBackfill(@Body() body: unknown) {
    const parsed = postsTopicsBackfillSchema.parse(body ?? {});
    const job = await this.jobs.enqueue(
      JOBS.postsTopicsBackfill,
      {
      wipeExisting: Boolean(parsed.wipeExisting),
      batchSize: parsed.batchSize ?? undefined,
      lookbackDays: parsed.lookbackDays ?? undefined,
      },
      { removeOnComplete: true, removeOnFail: false },
    );
    return { data: { ok: true, jobId: String(job.id) } };
  }

  @Post('topics-normalize')
  async normalizeTopicsEverywhere(@Body() body: unknown) {
    const parsed = normalizeTopicsSchema.parse(body ?? {});
    const normalizeUsers = parsed.users !== false;
    const normalizeFollows = parsed.follows !== false;

    if (normalizeUsers) {
      const users = await this.prisma.user.findMany({
        select: { id: true, interests: true },
      });
      await this.prisma.$transaction(
        users.map((u) => {
          const interests = Array.isArray(u.interests) ? (u.interests as string[]) : [];
          const next = Array.from(
            new Set(
              interests
                .map((s) => (canonicalizeTopicValue(s) ?? String(s ?? '').trim()).trim())
                .filter(Boolean),
            ),
          ).slice(0, 30);
          return this.prisma.user.update({ where: { id: u.id }, data: { interests: next } });
        }),
      );
    }

    if (normalizeFollows) {
      const rows = await this.prisma.topicFollow.findMany({
        select: { userId: true, topic: true },
      });
      // Rewrite each follow to canonical topic (delete old, upsert new).
      // Early-stage: do it in a transaction; avoids unique collisions.
      await this.prisma.$transaction(
        rows.flatMap((r) => {
          const mapped = canonicalizeTopicValue(r.topic) ?? String(r.topic ?? '').trim();
          const next = (mapped ?? '').trim();
          if (!next || next === r.topic) return [];
          return [
            this.prisma.topicFollow.deleteMany({ where: { userId: r.userId, topic: r.topic } }),
            this.prisma.topicFollow.upsert({
              where: { userId_topic: { userId: r.userId, topic: next } },
              create: { userId: r.userId, topic: next },
              update: {},
            }),
          ];
        }),
      );
    }

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
    const now = new Date();

    // Find users whose premium flag is stale: premium but no active Stripe sub and no active grants.
    // NOTE: Prisma/SQL `notIn` does not match NULL rows, so we must explicitly include the null case.
    const staleUsers = await this.prisma.user.findMany({
      where: {
        OR: [{ premium: true }, { premiumPlus: true }],
        AND: [
          {
            OR: [
              { stripeSubscriptionStatus: null },
              { stripeSubscriptionStatus: { notIn: ['active', 'trialing', 'past_due'] } },
            ],
          },
          { subscriptionGrants: { none: { revokedAt: null, endsAt: { gt: now } } } },
        ],
      },
      select: { id: true },
    });

    let fixed = 0;
    for (const user of staleUsers) {
      await this.entitlement.recomputeAndApply(user.id);
      fixed++;
    }

    return { data: { ok: true, scanned: staleUsers.length, fixed } };
  }

  /**
   * Recompute checkinStreakDays, longestStreakDays, and lastCheckinDayKey for every
   * user by walking their full post history (any non-onlyMe post counts, same rule
   * as live streak awarding). Useful to backfill users who posted before the streak
   * feature launched or whose streak fields are otherwise stale/missing.
   *
   * The nightly streak-reset cron will still zero out stale current streaks after
   * this runs — no double-handling needed.
   */
  @Post('streaks-backfill')
  async runStreaksBackfill() {
    const users = await this.prisma.user.findMany({ select: { id: true } });

    let updated = 0;

    for (const { id: userId } of users) {
      const posts = await this.prisma.post.findMany({
        where: { userId, visibility: { not: 'onlyMe' } },
        select: { createdAt: true },
        orderBy: { createdAt: 'asc' },
      });

      if (posts.length === 0) continue;

      // Deduplicate to one entry per ET calendar day then sort.
      const dayKeys = [
        ...new Set(posts.map((p) => easternDayKey(p.createdAt))),
      ].sort();

      // Walk sorted day keys to reconstruct streak progression.
      let streak = 1;
      let longestStreak = 1;

      for (let i = 1; i < dayKeys.length; i++) {
        // Compare as UTC-noon dates so DST transitions don't affect the diff.
        const prevMs = new Date(dayKeys[i - 1] + 'T12:00:00Z').getTime();
        const currMs = new Date(dayKeys[i] + 'T12:00:00Z').getTime();
        const diffDays = Math.round((currMs - prevMs) / 86_400_000);
        streak = diffDays === 1 ? streak + 1 : 1;
        if (streak > longestStreak) longestStreak = streak;
      }

      const lastCheckinDayKey = dayKeys[dayKeys.length - 1];

      await this.prisma.user.update({
        where: { id: userId },
        data: { checkinStreakDays: streak, longestStreakDays: longestStreak, lastCheckinDayKey },
      });

      updated++;
    }

    return { data: { ok: true, scanned: users.length, updated } };
  }
}

