import { Injectable, Logger } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import { PrismaService } from '../prisma/prisma.service';
import { JobsService } from '../jobs/jobs.service';
import { JOBS } from '../jobs/jobs.constants';
import { AppConfigService } from '../app/app-config.service';
import { FANOUT_CONCURRENCY, runInBatches } from '../side-effects/batch';
import { BELL_EXCLUDED_KINDS } from './notification-read-state.service';

@Injectable()
export class NotificationsCleanupCron {
  private readonly logger = new Logger(NotificationsCleanupCron.name);
  private running = false;

  constructor(
    private readonly prisma: PrismaService,
    private readonly jobs: JobsService,
    private readonly appConfig: AppConfigService,
  ) {}

  /** Read notifications older than this are deleted. */
  private readonly readRetentionDays = 90;

  /**
   * Unread notifications older than this are deleted.
   * X keeps ~30 days; we use 180 days so long-absent users don't return to a
   * completely empty bell, while still preventing indefinite accumulation.
   */
  private readonly unreadRetentionDays = 180;

  @Cron('0 4 * * *')
  async cleanupOldNotifications() {
    if (!this.appConfig.runSchedulers()) return;
    try {
      await this.jobs.enqueueCron(JOBS.notificationsCleanup, {}, 'cron-notificationsCleanup', {
        attempts: 2,
        backoff: { type: 'exponential', delay: 5 * 60_000 },
      });
    } catch {
      // likely duplicate jobId while previous run is active; treat as no-op
    }
  }

  async runCleanupOldReadNotifications() {
    if (this.running) return;
    this.running = true;
    const startedAt = Date.now();
    try {
      // 1. Delete read notifications beyond their retention window.
      const readCutoff = new Date(Date.now() - this.readRetentionDays * 24 * 60 * 60 * 1000);
      const deletedRead = await this.prisma.notification.deleteMany({
        where: { readAt: { not: null, lt: readCutoff } },
      });

      // 2. Delete old unread notifications and fix the denormalised bell counter.
      //    We only touch bell-counted kinds; excluded kinds (messages, group posts)
      //    are never counted in undeliveredNotificationCount.
      const unreadCutoff = new Date(Date.now() - this.unreadRetentionDays * 24 * 60 * 60 * 1000);

      const staleUnread = await this.prisma.notification.groupBy({
        by: ['recipientUserId'],
        where: {
          readAt: null,
          createdAt: { lt: unreadCutoff },
          kind: { notIn: BELL_EXCLUDED_KINDS },
        },
        _count: true,
      });

      const deletedUnread = await this.prisma.notification.deleteMany({
        where: { readAt: null, createdAt: { lt: unreadCutoff } },
      });

      if (staleUnread.length > 0) {
        await runInBatches(staleUnread, FANOUT_CONCURRENCY, async (row) => {
          await this.prisma.user.update({
            where: { id: row.recipientUserId },
            data: { undeliveredNotificationCount: { decrement: row._count } },
          });
        });
      }

      const ms = Date.now() - startedAt;
      const totalDeleted = (deletedRead.count ?? 0) + (deletedUnread.count ?? 0);
      if (totalDeleted > 0) {
        this.logger.log(
          `Notifications cleanup: deletedRead=${deletedRead.count} deletedUnread=${deletedUnread.count} ` +
            `readRetentionDays=${this.readRetentionDays} unreadRetentionDays=${this.unreadRetentionDays} (${ms}ms)`,
        );
      }

      // 3. Prune stale push-coalesce records (max window is 15 min; >1 day is safe to drop).
      const coalesceCutoff = new Date(Date.now() - 24 * 60 * 60 * 1000);
      await this.prisma.pushCoalesce.deleteMany({ where: { sentAt: { lt: coalesceCutoff } } });
    } catch (err) {
      this.logger.warn(`Notifications cleanup failed: ${(err as Error).message}`);
    } finally {
      this.running = false;
    }
  }
}

