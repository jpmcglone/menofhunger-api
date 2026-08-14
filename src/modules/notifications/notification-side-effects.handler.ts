import { Injectable, Logger, type OnModuleInit } from '@nestjs/common';
import { FANOUT_CONCURRENCY, runInBatches } from '../side-effects/batch';
import type { SideEffectPayloads } from '../side-effects/side-effects.constants';
import { SideEffectsRegistry } from '../side-effects/side-effects.registry';
import { SideEffectsService } from '../side-effects/side-effects.service';
import { RedisService } from '../redis/redis.service';
import { RedisKeys } from '../redis/redis-keys';
import { PresenceRedisStateService } from '../presence/presence-redis-state.service';
import { NotificationPushService } from './notification-push.service';
import { NotificationWriterService } from './notification-writer.service';
import { ApnsPushService } from './apns-push.service';

/** Collapse rapid badge syncs from feed scroll / mark-read bursts. */
const BADGE_SYNC_DEBOUNCE_MS = 1_500;
/** Schedule one trailing flush just after the debounce window. */
const BADGE_SYNC_TRAILING_DELAY_MS = 1_600;

/**
 * Queue-side delivery for notifications: the push send, fan-out chunks, and
 * debounced badge-only APNs sync.
 *
 * Push involves external network calls (APNs, VAPID) that fail transiently and used to be
 * fire-and-forget with no retry. Fan-out to a large follower set is the one thing that can
 * make the whole process slow if it runs unbounded. Badge sync is high-churn (views batches)
 * so it is debounced + skipped when an active iOS socket already drives the icon.
 */
@Injectable()
export class NotificationSideEffectsHandler implements OnModuleInit {
  private readonly logger = new Logger(NotificationSideEffectsHandler.name);

  constructor(
    private readonly push: NotificationPushService,
    private readonly writer: NotificationWriterService,
    private readonly registry: SideEffectsRegistry,
    private readonly apns: ApnsPushService,
    private readonly redis: RedisService,
    private readonly presenceRedis: PresenceRedisStateService,
    private readonly sideEffects: SideEffectsService,
  ) {}

  onModuleInit(): void {
    this.registry.register('notification.push', (payload) => this.onPush(payload));
    this.registry.register('notification.fanout.chunk', (payload) => this.onFanoutChunk(payload));
    this.registry.register('notification.badge.sync', (payload) => this.onBadgeSync(payload));
    this.registry.register('notification.lockScreen.clear', (payload) => this.onLockScreenClear(payload));
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

  /**
   * Debounced badge-only APNs. Skips when an active iOS socket exists (socket path already
   * updates the icon). Web-only presence does not skip. Change-only vs last sent.
   */
  private async onBadgeSync(payload: SideEffectPayloads['notification.badge.sync']): Promise<void> {
    const userId = (payload.recipientUserId ?? '').trim();
    if (!userId) return;

    const debounceKey = RedisKeys.badgeSyncDebounce(userId);
    const acquired = await this.redis.setString(debounceKey, '1', {
      ttlMs: BADGE_SYNC_DEBOUNCE_MS,
      onlyIfAbsent: true,
    });
    if (!acquired) {
      // One trailing flush after the window so the final count still lands.
      this.sideEffects.dispatch(
        'notification.badge.sync',
        { recipientUserId: userId },
        { jobId: `badge-sync-trail:${userId}`, delay: BADGE_SYNC_TRAILING_DELAY_MS },
      );
      return;
    }

    let badge: number;
    const bellHint = payload.undeliveredBellCount;
    const groupsHint = payload.undeliveredGroupsCount;
    if (
      typeof bellHint === 'number' &&
      Number.isFinite(bellHint) &&
      typeof groupsHint === 'number' &&
      Number.isFinite(groupsHint)
    ) {
      badge = Math.max(0, Math.floor(bellHint)) + Math.max(0, Math.floor(groupsHint));
    } else {
      badge = await this.apns.computeAppIconBadge(userId);
    }

    const lastKey = RedisKeys.badgeSyncLastSent(userId);
    const lastRaw = await this.redis.getString(lastKey);
    if (lastRaw != null && Number(lastRaw) === badge) return;

    if (await this.presenceRedis.isUserActivelyOnIos(userId)) {
      // Do not record lastSent — home-screen may still need APNs when iOS goes idle.
      return;
    }

    await this.apns.sendBadgeOnly(userId, badge);
    await this.redis.setString(lastKey, String(badge), { ttlSeconds: 86_400 });
  }

  private async onLockScreenClear(
    payload: SideEffectPayloads['notification.lockScreen.clear'],
  ): Promise<void> {
    const userId = (payload.recipientUserId ?? '').trim();
    const section = payload.section === 'groups' ? 'groups' : payload.section === 'inbox' ? 'inbox' : null;
    if (!userId || !section) return;
    await this.apns.sendClearDelivered(userId, section);
  }
}
