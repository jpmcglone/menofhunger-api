import { Injectable, type OnModuleInit } from '@nestjs/common';
import { NotificationsService } from '../notifications/notifications.service';
import { FANOUT_CONCURRENCY, runInBatches } from '../side-effects/batch';
import type { SideEffectPayloads } from '../side-effects/side-effects.constants';
import { SideEffectsRegistry } from '../side-effects/side-effects.registry';
import { SpacesService } from './spaces.service';

function formatScheduleWhen(isoOrDate: string | Date): string {
  const d = typeof isoOrDate === 'string' ? new Date(isoOrDate) : isoOrDate;
  if (Number.isNaN(d.getTime())) return '';
  return new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/New_York',
    weekday: 'short',
    month: 'short',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
    timeZoneName: 'short',
  }).format(d);
}

/**
 * Post-commit fan-out for space schedule: live / cancel / reschedule / reminder.
 */
@Injectable()
export class SpacesSideEffectsHandler implements OnModuleInit {
  constructor(
    private readonly spaces: SpacesService,
    private readonly notifications: NotificationsService,
    private readonly registry: SideEffectsRegistry,
  ) {}

  onModuleInit(): void {
    this.registry.register('space.schedule.live', (p) => this.onLive(p));
    this.registry.register('space.schedule.cancelled', (p) => this.onCancelled(p));
    this.registry.register('space.schedule.rescheduled', (p) => this.onRescheduled(p));
    this.registry.register('space.schedule.reminder', (p) => this.onReminder(p));
  }

  private async onLive(payload: SideEffectPayloads['space.schedule.live']): Promise<void> {
    const snap = await this.spaces.getScheduleSnapshot(payload.spaceId);
    // Schedule is cleared on activate — still fan out to subscribers.
    // Host already knows they're going live; skip self.
    const recipients = (await this.spaces.listSubscriberUserIds(payload.spaceId)).filter(
      (id) => id !== snap?.ownerUserId,
    );
    if (recipients.length === 0) return;

    const title = snap ? `${snap.title} is live` : 'Space is live';
    const body = 'Tap to join now.';
    const actorUserId = snap?.ownerUserId ?? null;

    await runInBatches(recipients, FANOUT_CONCURRENCY, async (recipientUserId) => {
      await this.notifications.upsertSpaceScheduleNotification({
        recipientUserId,
        kind: 'space_live',
        spaceId: payload.spaceId,
        actorUserId,
        title,
        body,
      });
    });
  }

  private async onCancelled(payload: SideEffectPayloads['space.schedule.cancelled']): Promise<void> {
    const recipients = (
      payload.recipientUserIds ?? (await this.spaces.listSubscriberUserIds(payload.spaceId))
    ).filter((id) => id !== payload.ownerUserId);
    if (recipients.length === 0) return;

    const title = `${payload.spaceTitle} cancelled`;
    const body = 'The scheduled space was cancelled.';

    await runInBatches(recipients, FANOUT_CONCURRENCY, async (recipientUserId) => {
      await this.notifications.upsertSpaceScheduleNotification({
        recipientUserId,
        kind: 'space_schedule_cancelled',
        spaceId: payload.spaceId,
        actorUserId: payload.ownerUserId,
        title,
        body,
      });
    });
  }

  private async onRescheduled(payload: SideEffectPayloads['space.schedule.rescheduled']): Promise<void> {
    const snap = await this.spaces.getScheduleSnapshot(payload.spaceId);
    if (!snap?.scheduledAt) return;
    const recipients = (await this.spaces.listSubscriberUserIds(payload.spaceId)).filter(
      (id) => id !== snap.ownerUserId,
    );
    if (recipients.length === 0) return;

    const when = formatScheduleWhen(payload.scheduledAt);
    const title = `${snap.title} rescheduled`;
    const body = when ? `Now ${when}.` : 'The start time changed.';

    await runInBatches(recipients, FANOUT_CONCURRENCY, async (recipientUserId) => {
      await this.notifications.upsertSpaceScheduleNotification({
        recipientUserId,
        kind: 'space_schedule_cancelled',
        spaceId: payload.spaceId,
        actorUserId: snap.ownerUserId,
        title,
        body,
      });
    });
  }

  private async onReminder(payload: SideEffectPayloads['space.schedule.reminder']): Promise<void> {
    const snap = await this.spaces.getScheduleSnapshot(payload.spaceId);
    if (!snap?.scheduledAt) return;
    if (snap.scheduledAt.getTime() !== payload.scheduledAtMs) return;
    if (snap.scheduledAt.getTime() <= Date.now()) return;

    const isDay = payload.kind === 'space_reminder_day';
    // Host only wants the ~15 min heads-up — not the morning "today" ping.
    let recipients = await this.spaces.listSubscriberUserIds(payload.spaceId);
    if (isDay) {
      recipients = recipients.filter((id) => id !== snap.ownerUserId);
    }
    if (recipients.length === 0) return;

    const when = formatScheduleWhen(snap.scheduledAt);
    const title = isDay ? `${snap.title} today` : `${snap.title} starting soon`;
    const body = isDay
      ? when
        ? `Scheduled for ${when}.`
        : 'A space you asked about is today.'
      : 'Starts in about 15 minutes.';

    await runInBatches(recipients, FANOUT_CONCURRENCY, async (recipientUserId) => {
      await this.notifications.upsertSpaceScheduleNotification({
        recipientUserId,
        kind: payload.kind,
        spaceId: payload.spaceId,
        actorUserId: snap.ownerUserId,
        title,
        body,
      });
    });
  }
}
