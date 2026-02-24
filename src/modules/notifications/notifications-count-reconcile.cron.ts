import { Injectable, Logger } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import { PrismaService } from '../prisma/prisma.service';
import { JobsService } from '../jobs/jobs.service';
import { JOBS } from '../jobs/jobs.constants';
import { AppConfigService } from '../app/app-config.service';

/**
 * Nightly job that recomputes undeliveredNotificationCount for every user
 * by counting actual Notification rows with deliveredAt IS NULL.
 *
 * The denormalized counter can drift over time (e.g. orphan cleanup deleting
 * rows without decrementing, race conditions, future bugs). A nightly
 * reconcile keeps the badge counts accurate without needing perfect
 * increment/decrement bookkeeping everywhere.
 *
 * Runs at 3:15 AM ET, after the orphan cleanup (4:15 AM UTC ≈ 12:15 AM ET —
 * actually let's run at 6:15 AM UTC ≈ 2:15 AM ET, before the other 4 AM jobs).
 */
@Injectable()
export class NotificationsCountReconcileCron {
  private readonly logger = new Logger(NotificationsCountReconcileCron.name);
  private running = false;

  constructor(
    private readonly prisma: PrismaService,
    private readonly jobs: JobsService,
    private readonly appConfig: AppConfigService,
  ) {}

  @Cron('30 6 * * *')
  async scheduleReconcile() {
    if (!this.appConfig.runSchedulers()) return;
    try {
      await this.jobs.enqueueCron(
        JOBS.notificationsCountReconcile,
        {},
        'cron:notificationsCountReconcile',
        { attempts: 2, backoff: { type: 'exponential', delay: 5 * 60_000 } },
      );
    } catch {
      // duplicate jobId = already enqueued; safe to swallow
    }
  }

  async runReconcile(): Promise<void> {
    if (this.running) return;
    this.running = true;
    const startedAt = Date.now();
    try {
      // Raw SQL is the simplest way to do a bulk correlated-subquery update.
      const result: Array<{ affected: bigint }> = await this.prisma.$queryRaw`
        WITH corrected AS (
          SELECT
            u.id                                      AS "userId",
            GREATEST(0, COUNT(n.id)::INTEGER)         AS "correct"
          FROM "User" u
          LEFT JOIN "Notification" n
            ON n."recipientUserId" = u.id
           AND n."deliveredAt" IS NULL
          GROUP BY u.id
          HAVING GREATEST(0, COUNT(n.id)::INTEGER) <> u."undeliveredNotificationCount"
        )
        UPDATE "User" u
        SET "undeliveredNotificationCount" = c."correct"
        FROM corrected c
        WHERE u.id = c."userId"
        RETURNING 1 AS affected
      `;
      const affected = result.length;
      const ms = Date.now() - startedAt;
      if (affected > 0) {
        this.logger.log(`Notification count reconcile: corrected ${affected} user(s) (${ms}ms)`);
      } else {
        this.logger.debug(`Notification count reconcile: all counts were already correct (${ms}ms)`);
      }
    } catch (err) {
      this.logger.error(
        `Notification count reconcile failed: ${(err as Error)?.message ?? String(err)}`,
        err instanceof Error ? err.stack : undefined,
      );
      throw err;
    } finally {
      this.running = false;
    }
  }
}
