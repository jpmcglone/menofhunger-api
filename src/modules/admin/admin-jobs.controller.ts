import { Body, Controller, Get, Post, UseGuards } from '@nestjs/common';
import { z } from 'zod';
import { AdminGuard } from './admin.guard';
import { AuthCleanupCron } from '../auth/auth-cleanup.cron';
import { SearchCleanupCron } from '../search/search-cleanup.cron';
import { NotificationsCleanupCron } from '../notifications/notifications-cleanup.cron';
import { NotificationsOrphanCleanupCron } from '../notifications/notifications-orphan-cleanup.cron';
import { HashtagsCleanupCron } from '../hashtags/hashtags-cleanup.cron';
import { PostsTopicsBackfillCron } from '../posts/posts-topics-backfill.cron';
import { PostsPopularScoreCron } from '../posts/posts-popular-score.cron';
import { HashtagsTrendingScoreCron } from '../hashtags/hashtags-trending-score.cron';
import { LinkMetadataCron } from '../link-metadata/link-metadata.cron';
import { AdminHashtagsService } from './admin-hashtags.service';

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

@UseGuards(AdminGuard)
@Controller('admin/jobs')
export class AdminJobsController {
  constructor(
    private readonly authCleanup: AuthCleanupCron,
    private readonly searchCleanup: SearchCleanupCron,
    private readonly notificationsCleanup: NotificationsCleanupCron,
    private readonly notificationsOrphanCleanup: NotificationsOrphanCleanupCron,
    private readonly hashtagsCleanup: HashtagsCleanupCron,
    private readonly postsTopicsBackfill: PostsTopicsBackfillCron,
    private readonly postsPopularRefresh: PostsPopularScoreCron,
    private readonly hashtagsTrendingRefresh: HashtagsTrendingScoreCron,
    private readonly linkMetadataBackfill: LinkMetadataCron,
    private readonly adminHashtags: AdminHashtagsService,
  ) {}

  @Get('hashtags/backfill')
  async hashtagBackfillStatus() {
    return await this.adminHashtags.getBackfillStatus();
  }

  @Post('hashtags/backfill')
  async hashtagBackfill(@Body() body: unknown) {
    const parsed = hashtagBackfillSchema.parse(body ?? {});
    return await this.adminHashtags.runBackfillBatch({
      runId: parsed.runId ?? null,
      cursor: parsed.cursor ?? null,
      batchSize: parsed.batchSize ?? 500,
      reset: Boolean(parsed.reset),
    });
  }

  @Post('auth-cleanup')
  async runAuthCleanup() {
    await this.authCleanup.cleanupExpiredAuthRecords();
    return { data: { ok: true } };
  }

  @Post('search-cleanup')
  async runSearchCleanup() {
    await this.searchCleanup.cleanupUserSearchHistory();
    return { data: { ok: true } };
  }

  @Post('notifications-cleanup')
  async runNotificationsCleanup() {
    await this.notificationsCleanup.cleanupOldReadNotifications();
    return { data: { ok: true } };
  }

  @Post('notifications-orphan-cleanup')
  async runNotificationsOrphanCleanup() {
    await this.notificationsOrphanCleanup.cleanupDeletedPostNotifications();
    return { data: { ok: true } };
  }

  @Post('hashtags-cleanup')
  async runHashtagsCleanup() {
    await this.hashtagsCleanup.cleanupOrphanHashtags();
    return { data: { ok: true } };
  }

  @Post('posts-topics-backfill')
  async runPostsTopicsBackfill(@Body() body: unknown) {
    const parsed = postsTopicsBackfillSchema.parse(body ?? {});
    await this.postsTopicsBackfill.backfill({
      wipeExisting: Boolean(parsed.wipeExisting),
      batchSize: parsed.batchSize ?? undefined,
      lookbackDays: parsed.lookbackDays ?? undefined,
    });
    return { data: { ok: true } };
  }

  @Post('posts-popular-refresh')
  async runPostsPopularRefresh() {
    await this.postsPopularRefresh.refreshPopularSnapshots();
    return { data: { ok: true } };
  }

  @Post('hashtags-trending-refresh')
  async runHashtagsTrendingRefresh() {
    await this.hashtagsTrendingRefresh.refreshTrendingHashtagSnapshots();
    return { data: { ok: true } };
  }

  @Post('link-metadata-backfill')
  async runLinkMetadataBackfill() {
    await this.linkMetadataBackfill.handleBackfill();
    return { data: { ok: true } };
  }
}

