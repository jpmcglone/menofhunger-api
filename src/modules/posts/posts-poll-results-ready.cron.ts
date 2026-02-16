import { Injectable, Logger } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import { PrismaService } from '../prisma/prisma.service';
import { NotificationsService } from '../notifications/notifications.service';
import { PresenceRealtimeService } from '../presence/presence-realtime.service';
import { JobsService } from '../jobs/jobs.service';
import { JOBS } from '../jobs/jobs.constants';
import { AppConfigService } from '../app/app-config.service';

@Injectable()
export class PostsPollResultsReadyCron {
  private readonly logger = new Logger(PostsPollResultsReadyCron.name);
  private running = false;

  constructor(
    private readonly prisma: PrismaService,
    private readonly notifications: NotificationsService,
    private readonly presenceRealtime: PresenceRealtimeService,
    private readonly jobs: JobsService,
    private readonly appConfig: AppConfigService,
  ) {}

  /**
   * Poll results-ready notifications:
   * - Notify poll author when poll ends.
   * - Notify every user who voted when poll ends.
   *
   * We do NOT schedule one job per poll; instead we run a lightweight periodic sweep.
   * This keeps deploys/restarts simple and avoids managing a dynamic job registry.
   */
  @Cron('*/1 * * * *')
  async notifyEndedPolls() {
    if (!this.appConfig.runSchedulers()) return;
    try {
      await this.jobs.enqueueCron(JOBS.postsPollResultsReadySweep, {}, 'cron:postsPollResultsReadySweep', {
        attempts: 3,
        backoff: { type: 'exponential', delay: 30_000 },
      });
    } catch {
      // likely duplicate jobId while previous run is active; treat as no-op
    }
  }

  async runPollResultsReadySweep() {
    if (this.running) return;
    this.running = true;
    const startedAt = Date.now();
    const now = new Date();

    try {
      const polls = await this.prisma.postPoll.findMany({
        where: {
          endsAt: { lte: now },
          resultsNotifiedAt: null,
          post: { deletedAt: null },
        },
        orderBy: [{ endsAt: 'asc' }, { id: 'asc' }],
        take: 25,
        select: {
          id: true,
          postId: true,
          post: { select: { userId: true, body: true } },
        },
      });

      if (polls.length === 0) return;

      for (const p of polls) {
        const pollId = p.id;
        const postId = p.postId;
        const authorId = p.post.userId;
        const postBodySnippet = (p.post.body ?? '').trim().slice(0, 150) || null;

        // Re-check in a transaction so multiple cron ticks (or instances) don't double-notify.
        const recipientUserIds = await this.prisma.$transaction(async (tx) => {
          const livePost = await tx.post.findUnique({
            where: { id: postId },
            select: { deletedAt: true },
          });
          if (livePost?.deletedAt) {
            // Post was deleted after we queried polls; don't notify.
            // (We still allow the lock below to prevent future notifications if restored.)
          }

          const lock = await tx.postPoll.updateMany({
            where: { id: pollId, resultsNotifiedAt: null },
            data: { resultsNotifiedAt: now },
          });
          if (lock.count !== 1) return [];

          if (livePost?.deletedAt) return [];

          const voters = await tx.postPollVote.findMany({
            where: { pollId },
            select: { userId: true },
            distinct: ['userId'],
          });

          const recipients = new Set<string>([authorId, ...voters.map((v) => v.userId)].filter(Boolean));
          const list = [...recipients];
          if (list.length === 0) return [];

          // Create notifications (in-app). We intentionally keep this small and generic.
          // Clicking the row routes to the poll post via subjectPostId.
          await tx.notification.createMany({
            data: list.map((uid) => ({
              recipientUserId: uid,
              kind: 'poll_results_ready',
              actorUserId: authorId,
              subjectPostId: postId,
              title: uid === authorId ? 'Your poll is done' : 'Poll results are ready',
              body: postBodySnippet ?? 'Tap to see the final results.',
            })),
          });

          return list;
        });

        // Best-effort realtime badge update (no per-notification payload).
        for (const uid of recipientUserIds) {
          try {
            const undeliveredCount = await this.notifications.getUndeliveredCount(uid);
            this.presenceRealtime.emitNotificationsUpdated(uid, { undeliveredCount });
          } catch {
            // best-effort
          }
        }
      }

      const ms = Date.now() - startedAt;
      this.logger.log(`Poll results-ready sweep: processed=${polls.length} (${ms}ms)`);
    } catch (err) {
      this.logger.warn(`Poll results-ready sweep failed: ${(err as Error).message}`);
    } finally {
      this.running = false;
    }
  }
}

