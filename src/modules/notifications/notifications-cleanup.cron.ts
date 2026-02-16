import { Injectable, Logger } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import { PrismaService } from '../prisma/prisma.service';
import { JobsService } from '../jobs/jobs.service';
import { JOBS } from '../jobs/jobs.constants';
import { AppConfigService } from '../app/app-config.service';

@Injectable()
export class NotificationsCleanupCron {
  private readonly logger = new Logger(NotificationsCleanupCron.name);
  private running = false;

  constructor(
    private readonly prisma: PrismaService,
    private readonly jobs: JobsService,
    private readonly appConfig: AppConfigService,
  ) {}

  /** Retention window for read notifications. */
  private readonly retentionDays = 90;

  @Cron('0 4 * * *')
  async cleanupOldReadNotifications() {
    if (!this.appConfig.runSchedulers()) return;
    try {
      await this.jobs.enqueueCron(JOBS.notificationsCleanup, {}, 'cron:notificationsCleanup', {
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
      const cutoff = new Date(Date.now() - this.retentionDays * 24 * 60 * 60 * 1000);
      const deleted = await this.prisma.notification.deleteMany({
        where: {
          readAt: { not: null, lt: cutoff },
        },
      });
      const ms = Date.now() - startedAt;
      if ((deleted.count ?? 0) > 0) {
        this.logger.log(
          `Notifications cleanup: deleted=${deleted.count} retentionDays=${this.retentionDays} (${ms}ms)`,
        );
      }
    } catch (err) {
      this.logger.warn(`Notifications cleanup failed: ${(err as Error).message}`);
    } finally {
      this.running = false;
    }
  }
}

