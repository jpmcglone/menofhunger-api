import { Injectable, Logger } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import { PrismaService } from '../prisma/prisma.service';
import { JobsService } from '../jobs/jobs.service';
import { JOBS } from '../jobs/jobs.constants';
import { AppConfigService } from '../app/app-config.service';
import { NotificationsService } from './notifications.service';

/**
 * Once-per-notification "still waiting on you" push for reply notifications.
 *
 * The brief: at 5 DAU the only pushes that earn their place are ones tied to a real human
 * doing a real thing to the recipient. A reply that's gone unread for >24h is exactly that —
 * "John still cares about your answer." We send one push, ever, per notification, then mark
 * `nudgedBackAt` so we never repeat.
 *
 * Bounded to 7 days so we don't dredge up archaeology if the recipient hasn't logged in in weeks.
 */
@Injectable()
export class NotificationsReplyNudgeCron {
  private readonly logger = new Logger(NotificationsReplyNudgeCron.name);
  private running = false;

  constructor(
    private readonly prisma: PrismaService,
    private readonly jobs: JobsService,
    private readonly appConfig: AppConfigService,
    private readonly notifications: NotificationsService,
  ) {}

  @Cron('*/15 * * * *')
  async enqueueReplyNudgeSweep() {
    if (!this.appConfig.runSchedulers()) return;
    try {
      await this.jobs.enqueueCron(JOBS.notificationsReplyNudgePush, {}, 'cron-notificationsReplyNudgePush', {
        attempts: 2,
        backoff: { type: 'exponential', delay: 5 * 60_000 },
      });
    } catch {
      // duplicate jobId while previous run is still active — treat as no-op
    }
  }

  async runReplyNudgeSweep() {
    if (this.running) return;
    this.running = true;
    const startedAt = Date.now();
    let sent = 0;
    try {
      const now = Date.now();
      const olderThan = new Date(now - 24 * 60 * 60 * 1000); // ≥ 24h old
      const newerThan = new Date(now - 7 * 24 * 60 * 60 * 1000); // < 7d old

      // Cap per run — protects the queue if the table grows large after backlog.
      const candidates = await this.prisma.notification.findMany({
        where: {
          kind: 'comment',
          readAt: null,
          nudgedBackAt: null,
          createdAt: { lt: olderThan, gt: newerThan },
          actorUserId: { not: null },
        },
        select: {
          id: true,
          recipientUserId: true,
          actorUserId: true,
          actorPostId: true,
          body: true,
        },
        orderBy: { createdAt: 'asc' },
        take: 200,
      });

      for (const n of candidates) {
        if (!n.actorUserId) continue;
        // Stamp first to avoid double-sends if the push helper races. The send is best-effort;
        // if it fails for transport reasons, the reply notification still surfaces in-app and
        // we deliberately don't retry — one nudge, ever.
        try {
          await this.prisma.notification.update({
            where: { id: n.id },
            data: { nudgedBackAt: new Date() },
          });
        } catch {
          continue;
        }
        try {
          await this.notifications.sendReplyNudgePush({
            recipientUserId: n.recipientUserId,
            actorUserId: n.actorUserId,
            notificationId: n.id,
            actorPostId: n.actorPostId ?? null,
            bodySnippet: n.body ?? null,
          });
          sent += 1;
        } catch (err) {
          this.logger.debug(`[reply-nudge] push failed for ${n.id}: ${(err as Error).message}`);
        }
      }

      const ms = Date.now() - startedAt;
      if (sent > 0) {
        this.logger.log(`Reply nudge sweep: sent=${sent} candidates=${candidates.length} (${ms}ms)`);
      }
    } catch (err) {
      this.logger.warn(`Reply nudge sweep failed: ${(err as Error).message}`);
    } finally {
      this.running = false;
    }
  }
}
