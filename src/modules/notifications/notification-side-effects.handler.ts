import { Injectable, Logger, type OnModuleInit } from '@nestjs/common';
import { FANOUT_CONCURRENCY, runInBatches } from '../side-effects/batch';
import type { SideEffectPayloads } from '../side-effects/side-effects.constants';
import { SideEffectsRegistry } from '../side-effects/side-effects.registry';
import { NotificationPushService } from './notification-push.service';
import { NotificationWriterService } from './notification-writer.service';

/**
 * Queue-side delivery for notifications: the push send, and one chunk of a large fan-out.
 *
 * These two effects are why the queue earns its keep. Push involves external network calls
 * (APNs, VAPID) that fail transiently and used to be fire-and-forget with no retry, and
 * fan-out to a large follower set is the one thing that can make the whole process slow if it
 * runs unbounded.
 */
@Injectable()
export class NotificationSideEffectsHandler implements OnModuleInit {
  private readonly logger = new Logger(NotificationSideEffectsHandler.name);

  constructor(
    private readonly push: NotificationPushService,
    private readonly writer: NotificationWriterService,
    private readonly registry: SideEffectsRegistry,
  ) {}

  onModuleInit(): void {
    this.registry.register('notification.push', (payload) => this.onPush(payload));
    this.registry.register('notification.fanout.chunk', (payload) => this.onFanoutChunk(payload));
  }

  /**
   * Send the push for a notification that was already written.
   *
   * Safe to retry: `sendKindPushForActor` consults `pushCoalesce`, which records the resolved
   * push tag when a send succeeds and suppresses another send for that tag inside the kind's
   * coalesce window. A retry after a partial failure therefore doesn't double-buzz.
   */
  private async onPush(payload: SideEffectPayloads['notification.push']): Promise<void> {
    if (!payload.recipientUserId || !payload.kind) return;
    await this.push.sendKindPushForActor(payload);
  }

  /**
   * One slice of a fan-out that was too large to do in a single job.
   *
   * The parent handler does all the eligibility filtering and passes only recipients that
   * should be notified, so this is a dumb writer — which is what makes it safely retryable.
   */
  private async onFanoutChunk(payload: SideEffectPayloads['notification.fanout.chunk']): Promise<void> {
    const recipients = (payload.recipientUserIds ?? []).filter(Boolean);
    if (recipients.length === 0) return;

    const result = await runInBatches(recipients, FANOUT_CONCURRENCY, async (recipientUserId) => {
      await this.writer.create({
        recipientUserId,
        kind: payload.kind,
        actorUserId: payload.actorUserId,
        actorPostId: payload.actorPostId,
        subjectPostId: payload.subjectPostId,
        subjectUserId: payload.subjectUserId,
        subjectArticleId: payload.subjectArticleId,
        subjectGroupId: payload.subjectGroupId,
        title: payload.title,
        body: payload.body,
      });
    });

    if (result.failed > 0) {
      this.logger.warn(
        `[notifications] fan-out chunk (${payload.kind}): ${result.failed}/${recipients.length} failed.`,
      );
    }
  }
}
