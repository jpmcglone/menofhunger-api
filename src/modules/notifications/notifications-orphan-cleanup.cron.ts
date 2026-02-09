import { Injectable, Logger } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import { PrismaService } from '../prisma/prisma.service';

@Injectable()
export class NotificationsOrphanCleanupCron {
  private readonly logger = new Logger(NotificationsOrphanCleanupCron.name);
  private running = false;

  constructor(private readonly prisma: PrismaService) {}

  /**
   * Best-effort cleanup for notifications that reference soft-deleted posts.
   * We delete:
   * - notifications where subjectPost is deleted
   * - notifications where actorPost is deleted
   *
   * Scheduled daily; safe to trigger manually from admin jobs.
   */
  @Cron('15 4 * * *')
  async cleanupDeletedPostNotifications() {
    if (this.running) return;
    this.running = true;
    const startedAt = Date.now();
    try {
      const deleted = await this.prisma.notification.deleteMany({
        where: {
          OR: [
            { subjectPost: { deletedAt: { not: null } } },
            { actorPost: { deletedAt: { not: null } } },
          ],
        },
      });
      const ms = Date.now() - startedAt;
      if ((deleted.count ?? 0) > 0) {
        this.logger.log(`Notifications orphan cleanup: deleted=${deleted.count} (${ms}ms)`);
      }
    } catch (err) {
      this.logger.warn(`Notifications orphan cleanup failed: ${(err as Error).message}`);
    } finally {
      this.running = false;
    }
  }
}

