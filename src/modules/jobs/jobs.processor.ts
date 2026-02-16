import { Processor, WorkerHost } from '@nestjs/bullmq';
import type { Job } from 'bullmq';
import { Logger } from '@nestjs/common';
import { MOH_BACKGROUND_QUEUE, JOBS } from './jobs.constants';
import { PostsPollResultsReadyCron } from '../posts/posts-poll-results-ready.cron';
import { PostsTopicsBackfillCron } from '../posts/posts-topics-backfill.cron';
import { PostsPopularScoreCron } from '../posts/posts-popular-score.cron';
import { HashtagsTrendingScoreCron } from '../hashtags/hashtags-trending-score.cron';
import { HashtagsCleanupCron } from '../hashtags/hashtags-cleanup.cron';
import { NotificationsCleanupCron } from '../notifications/notifications-cleanup.cron';
import { NotificationsOrphanCleanupCron } from '../notifications/notifications-orphan-cleanup.cron';
import { NotificationsEmailCron } from '../notifications/notifications-email.cron';
import { AuthCleanupCron } from '../auth/auth-cleanup.cron';
import { SearchCleanupCron } from '../search/search-cleanup.cron';
import { LinkMetadataCron } from '../link-metadata/link-metadata.cron';

@Processor(MOH_BACKGROUND_QUEUE)
export class JobsProcessor extends WorkerHost {
  private readonly logger = new Logger(JobsProcessor.name);

  constructor(
    private readonly postsPollResultsReady: PostsPollResultsReadyCron,
    private readonly postsTopicsBackfill: PostsTopicsBackfillCron,
    private readonly postsPopularScore: PostsPopularScoreCron,
    private readonly hashtagsTrending: HashtagsTrendingScoreCron,
    private readonly hashtagsCleanup: HashtagsCleanupCron,
    private readonly notificationsCleanup: NotificationsCleanupCron,
    private readonly notificationsOrphanCleanup: NotificationsOrphanCleanupCron,
    private readonly notificationsEmail: NotificationsEmailCron,
    private readonly authCleanup: AuthCleanupCron,
    private readonly searchCleanup: SearchCleanupCron,
    private readonly linkMetadata: LinkMetadataCron,
  ) {
    super();
  }

  override async process(job: Job): Promise<any> {
    const name = String(job.name ?? '');
    const startedAt = Date.now();
    try {
      switch (name) {
        case JOBS.postsPollResultsReadySweep:
          await this.postsPollResultsReady.runPollResultsReadySweep();
          return { ok: true };
        case JOBS.postsTopicsBackfill:
          await this.postsTopicsBackfill.runBackfill(job.data ?? undefined);
          return { ok: true };
        case JOBS.postsPopularScoreRefresh:
          await this.postsPopularScore.runRefreshPopularSnapshots();
          return { ok: true };
        case JOBS.hashtagsTrendingScoreRefresh:
          await this.hashtagsTrending.runRefreshTrendingHashtagSnapshots();
          return { ok: true };
        case JOBS.hashtagsCleanup:
          await this.hashtagsCleanup.runCleanupOrphanHashtags();
          return { ok: true };
        case JOBS.notificationsCleanup:
          await this.notificationsCleanup.runCleanupOldReadNotifications();
          return { ok: true };
        case JOBS.notificationsOrphanCleanup:
          await this.notificationsOrphanCleanup.runCleanupDeletedPostNotifications();
          return { ok: true };
        case JOBS.notificationsEmailNudges:
          await this.notificationsEmail.runSendNewNotificationsNudges();
          return { ok: true };
        case JOBS.notificationsWeeklyDigest:
          await this.notificationsEmail.runSendWeeklyDigest();
          return { ok: true };
        case JOBS.authCleanup:
          await this.authCleanup.runCleanupExpiredAuthRecords();
          return { ok: true };
        case JOBS.searchCleanup:
          await this.searchCleanup.runCleanupUserSearchHistory();
          return { ok: true };
        case JOBS.linkMetadataBackfill:
          await this.linkMetadata.runHandleBackfill();
          return { ok: true };
        default:
          this.logger.warn(`Unknown job name: ${name}`);
          return { ok: false, reason: 'unknown_job' };
      }
    } finally {
      const ms = Date.now() - startedAt;
      // Keep logs concise; job-specific cron runners already log details when meaningful.
      this.logger.debug(`Job ${name} done (${ms}ms)`);
    }
  }
}

