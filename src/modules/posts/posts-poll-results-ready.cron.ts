import { Injectable, Logger } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import { PrismaService } from '../prisma/prisma.service';
import { NotificationsService } from '../notifications/notifications.service';
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
   *
   * Delivery goes through NotificationsService.create so each recipient gets the full
   * fan-out (in-app row, undelivered counter, notifications:new, push).
   */
  @Cron('*/1 * * * *')
  async notifyEndedPolls() {
    if (!this.appConfig.runSchedulers()) return;
    try {
      await this.jobs.enqueueCron(JOBS.postsPollResultsReadySweep, {}, 'cron-postsPollResultsReadySweep', {
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
          _count: { select: { votes: true } },
        },
      });

      if (polls.length === 0) return;

      for (const p of polls) {
        const pollId = p.id;
        const postId = p.postId;
        const authorId = p.post.userId;
        const postBodySnippet = (p.post.body ?? '').trim().slice(0, 150) || null;
        const totalVotes = p._count.votes;
        const voteLabel =
          totalVotes === 0 ? 'No votes' : totalVotes === 1 ? '1 vote' : `${totalVotes} votes`;

        // Tiered copy — author gets engagement context, voters get a simple results ping.
        let authorTitle: string;
        if (totalVotes === 0) {
          authorTitle = 'Your poll was a dud · No votes';
        } else if (totalVotes < 10) {
          authorTitle = `Your poll got a few votes · ${voteLabel}`;
        } else if (totalVotes < 40) {
          authorTitle = `Your poll got real traction · ${voteLabel}`;
        } else {
          authorTitle = `Your poll was a hit · ${voteLabel}`;
        }

        let voterTitle: string;
        if (totalVotes < 10) {
          voterTitle = `Poll results are in · ${voteLabel}`;
        } else if (totalVotes < 40) {
          voterTitle = `Poll results are in · ${voteLabel}`;
        } else {
          voterTitle = `Great poll — results are in · ${voteLabel}`;
        }

        // Claim the poll in a transaction so concurrent sweeps don't double-notify.
        // Notification rows are created outside via NotificationsService.create so each
        // recipient gets push + notifications:new + undelivered counter increment.
        const recipientUserIds = await this.prisma.$transaction(async (tx) => {
          const livePost = await tx.post.findUnique({
            where: { id: postId },
            select: { deletedAt: true },
          });

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
          return [...recipients];
        });

        for (const uid of recipientUserIds) {
          try {
            const isAuthor = uid === authorId;
            // Author has no separate "actor" — omit actorUserId so create() does not
            // self-skip (it returns early when actorUserId === recipientUserId).
            await this.notifications.create({
              recipientUserId: uid,
              kind: 'poll_results_ready',
              ...(isAuthor ? {} : { actorUserId: authorId }),
              subjectPostId: postId,
              title: isAuthor
                ? authorTitle
                : voterTitle,
              body: postBodySnippet ?? 'Tap to see the final results.',
            });
          } catch (err) {
            this.logger.warn(
              `Poll results-ready notify failed pollId=${pollId} userId=${uid}: ${(err as Error).message}`,
            );
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
