import { Injectable, Logger, type OnModuleInit } from '@nestjs/common';
import { AppConfigService } from '../app/app-config.service';
import { buildFollowedSpaceEmail, type SpaceScheduleEmailKind } from '../email/email-content-space';
import { buildGreeting, getVerifiedRecipientEmail } from '../email/email-send.helpers';
import { EmailService } from '../email/email.service';
import { NotificationsService } from '../notifications/notifications.service';
import { PrismaService } from '../prisma/prisma.service';
import { chunk, FANOUT_CONCURRENCY, runInBatches } from '../side-effects/batch';
import {
  FANOUT_CHUNK_SIZE,
  FANOUT_CHUNK_THRESHOLD,
  type SideEffectPayloads,
} from '../side-effects/side-effects.constants';
import { SideEffectsRegistry } from '../side-effects/side-effects.registry';
import { SideEffectsService } from '../side-effects/side-effects.service';
import { SpacesService } from './spaces.service';
import { youtubeEmailPosterUrl } from './youtube-oembed-title';

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
  private readonly logger = new Logger(SpacesSideEffectsHandler.name);

  constructor(
    private readonly spaces: SpacesService,
    private readonly notifications: NotificationsService,
    private readonly registry: SideEffectsRegistry,
    private readonly sideEffects: SideEffectsService,
    private readonly prisma: PrismaService,
    private readonly email: EmailService,
    private readonly appConfig: AppConfigService,
  ) {}

  onModuleInit(): void {
    this.registry.register('space.schedule.live', (p) => this.onLive(p));
    this.registry.register('space.schedule.ended', (p) => this.onEnded(p));
    this.registry.register('space.schedule.cancelled', (p) => this.onCancelled(p));
    this.registry.register('space.schedule.rescheduled', (p) => this.onRescheduled(p));
    this.registry.register('space.schedule.reminder', (p) => this.onReminder(p));
    this.registry.register('space.schedule.announced', (p) => this.onAnnounced(p));
    this.registry.register('space.schedule.announce.chunk', (p) => this.onAnnounceChunk(p));
  }

  private uniqueRecipientIds(ids: string[], skipUserId?: string | null): string[] {
    const skip = (skipUserId ?? '').trim();
    const seen = new Set<string>();
    const out: string[] = [];
    for (const raw of ids) {
      const id = String(raw ?? '').trim();
      if (!id || id === skip || seen.has(id)) continue;
      seen.add(id);
      out.push(id);
    }
    return out;
  }

  private async onLive(payload: SideEffectPayloads['space.schedule.live']): Promise<void> {
    const snap = await this.spaces.getScheduleSnapshot(payload.spaceId);
    // Schedule is cleared on activate — still fan out to the pre-clear subscriber snapshot.
    // Host already knows they're going live; skip self.
    const fromPayload = payload.recipientUserIds ?? (await this.spaces.listSubscriberUserIds(payload.spaceId));
    const fromExisting = await this.notifications.listRecipientIdsForSpaceNotification({
      spaceId: payload.spaceId,
      kind: 'space_live',
    });
    const recipients = this.uniqueRecipientIds([...fromPayload, ...fromExisting], snap?.ownerUserId);
    if (recipients.length === 0) return;

    const title = snap ? `${snap.eventTitle || snap.title} is live` : 'Space is live';
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

  private async onEnded(payload: SideEffectPayloads['space.schedule.ended']): Promise<void> {
    const snap = await this.spaces.getScheduleSnapshot(payload.spaceId);
    const recipients = await this.notifications.listRecipientIdsForSpaceNotification({
      spaceId: payload.spaceId,
      kind: 'space_live',
    });
    if (recipients.length === 0) return;

    const spaceTitle = (snap?.eventTitle ?? snap?.title ?? payload.spaceTitle ?? '').trim();
    const title = spaceTitle ? `${spaceTitle} was live` : 'Space was live';
    const body = "It's no longer live.";
    const actorUserId = snap?.ownerUserId ?? null;

    await runInBatches(recipients, FANOUT_CONCURRENCY, async (recipientUserId) => {
      await this.notifications.upsertSpaceScheduleNotification({
        recipientUserId,
        kind: 'space_live',
        spaceId: payload.spaceId,
        actorUserId,
        title,
        body,
        resurface: false,
      });
    });
  }

  private async onCancelled(payload: SideEffectPayloads['space.schedule.cancelled']): Promise<void> {
    const snap = await this.spaces.getScheduleSnapshot(payload.spaceId);
    const eventTitle = (snap?.eventTitle || payload.spaceTitle || '').trim() || 'Space';
    const recipients = this.uniqueRecipientIds(
      payload.recipientUserIds ??
        (snap
          ? await this.spaces.listAudienceUserIds(payload.spaceId, payload.ownerUserId)
          : await this.spaces.listSubscriberUserIds(payload.spaceId)),
      payload.ownerUserId,
    );
    if (recipients.length === 0) return;

    const title = `${eventTitle} cancelled`;
    const body = 'The scheduled space was cancelled.';
    const emailCfg = this.appConfig.email();
    const ctx = this.spaceEmailContext({
      ownerUsername: snap?.ownerUsername ?? payload.ownerUsername,
      eventTitle,
    });

    await runInBatches(recipients, FANOUT_CONCURRENCY, async (recipientUserId) => {
      if (snap) {
        await this.notifications.upsertSpaceScheduleNotification({
          recipientUserId,
          kind: 'space_schedule_cancelled',
          spaceId: payload.spaceId,
          actorUserId: payload.ownerUserId,
          title,
          body,
        });
      }
      if (!emailCfg) return;
      await this.sendSpaceEmail({
        recipientUserId,
        hostName: ctx.hostName,
        spaceTitle: eventTitle,
        whenLabel: '',
        spaceUrl: ctx.spaceUrl,
        kind: 'cancelled',
        ...this.spaceEmailMedia(snap),
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
    const title = `${snap.eventTitle || snap.title} rescheduled`;
    const body = when ? `Now ${when}.` : 'The start time changed.';

    await runInBatches(recipients, FANOUT_CONCURRENCY, async (recipientUserId) => {
      await this.notifications.upsertSpaceScheduleNotification({
        recipientUserId,
        kind: 'space_schedule_rescheduled',
        spaceId: payload.spaceId,
        actorUserId: snap.ownerUserId,
        title,
        body,
      });
    });
  }

  private async onAnnounced(payload: SideEffectPayloads['space.schedule.announced']): Promise<void> {
    const snap = await this.spaces.getScheduleSnapshot(payload.spaceId);
    if (!snap?.scheduledAt) return;
    const recipients = await this.spaces.listFollowerUserIds(snap.ownerUserId);
    if (recipients.length === 0) return;
    if (recipients.length > FANOUT_CHUNK_THRESHOLD) {
      for (const slice of chunk(recipients, FANOUT_CHUNK_SIZE)) {
        this.sideEffects.dispatch('space.schedule.announce.chunk', {
          spaceId: payload.spaceId,
          recipientUserIds: slice,
        });
      }
      return;
    }
    await this.onAnnounceChunk({ spaceId: payload.spaceId, recipientUserIds: recipients });
  }

  private async onAnnounceChunk(
    payload: SideEffectPayloads['space.schedule.announce.chunk'],
  ): Promise<void> {
    const snap = await this.spaces.getScheduleSnapshot(payload.spaceId);
    if (!snap?.scheduledAt) return;
    const recipients = this.uniqueRecipientIds(payload.recipientUserIds ?? [], snap.ownerUserId);
    if (recipients.length === 0) return;

    const when = formatScheduleWhen(snap.scheduledAt);
    const eventTitle = snap.eventTitle || snap.title;
    const title = `${eventTitle} scheduled`;
    const body = when ? `Tune in ${when}.` : 'Someone you follow scheduled a space.';
    const emailCfg = this.appConfig.email();
    const ctx = this.spaceEmailContext({
      ownerUsername: snap.ownerUsername,
      eventTitle,
    });

    await runInBatches(recipients, FANOUT_CONCURRENCY, async (recipientUserId) => {
      await this.notifications.upsertSpaceScheduleNotification({
        recipientUserId,
        kind: 'followed_space',
        spaceId: payload.spaceId,
        actorUserId: snap.ownerUserId,
        title,
        body,
      });
      if (!emailCfg) return;
      await this.sendSpaceEmail({
        recipientUserId,
        hostName: ctx.hostName,
        spaceTitle: eventTitle,
        whenLabel: when,
        spaceUrl: ctx.spaceUrl,
        kind: 'announced',
        ...this.spaceEmailMedia(snap),
      });
    });
  }

  private spaceEmailContext(input: {
    ownerUsername?: string | null;
    eventTitle: string;
  }): { hostName: string; spaceUrl: string } {
    const baseUrl = frontendBase(this.appConfig.frontendBaseUrl());
    const username = (input.ownerUsername ?? '').trim();
    return {
      hostName: username || input.eventTitle,
      spaceUrl: username ? `${baseUrl}/s/${encodeURIComponent(username)}` : `${baseUrl}/spaces`,
    };
  }

  private spaceEmailMedia(snap: {
    watchPartyUrl?: string | null;
    playbackTitle?: string | null;
    eventTitle?: string | null;
    title?: string | null;
  } | null): { thumbnailUrl: string | null; videoTitle: string | null } {
    if (!snap) return { thumbnailUrl: null, videoTitle: null };
    const eventTitle = (snap.eventTitle || snap.title || '').trim();
    const playing = (snap.playbackTitle ?? '').trim();
    return {
      thumbnailUrl: youtubeEmailPosterUrl(snap.watchPartyUrl),
      videoTitle: playing && playing.toLowerCase() !== eventTitle.toLowerCase() ? playing : null,
    };
  }

  private async sendSpaceEmail(params: {
    recipientUserId: string;
    hostName: string;
    spaceTitle: string;
    whenLabel: string;
    spaceUrl: string;
    kind: SpaceScheduleEmailKind;
    thumbnailUrl?: string | null;
    videoTitle?: string | null;
  }): Promise<void> {
    const user = await this.prisma.user.findUnique({
      where: { id: params.recipientUserId },
      select: {
        id: true,
        email: true,
        emailVerifiedAt: true,
        name: true,
        username: true,
        notificationPreferences: { select: { emailFollowedArticle: true } },
      },
    });
    if (!user) return;
    if (user.notificationPreferences?.emailFollowedArticle === false) return;
    const to = getVerifiedRecipientEmail(user);
    if (!to) return;
    const emailCfg = this.appConfig.email();
    if (!emailCfg) return;
    const baseUrl = frontendBase(this.appConfig.frontendBaseUrl());
    const rendered = buildFollowedSpaceEmail({
      greeting: buildGreeting({ name: user.name, username: user.username }),
      hostName: params.hostName,
      spaceTitle: params.spaceTitle,
      whenLabel: params.whenLabel,
      spaceUrl: params.spaceUrl,
      settingsUrl: `${baseUrl}/settings/notifications`,
      kind: params.kind,
      thumbnailUrl: params.thumbnailUrl,
      videoTitle: params.videoTitle,
    });
    const from =
      emailCfg.fromEmail.notifications || emailCfg.fromEmail.default || emailCfg.fromEmail.newsletter;
    const sent = await this.email.sendText({
      to,
      from,
      subject: rendered.subject,
      text: rendered.text,
      html: rendered.html,
      category: 'engagement',
      userId: user.id,
    });
    if (!sent.sent) {
      this.logger.debug(`Followed-space email skipped ${user.id}: ${sent.reason ?? 'unknown'}`);
    }
  }

  private async onReminder(payload: SideEffectPayloads['space.schedule.reminder']): Promise<void> {
    const snap = await this.spaces.getScheduleSnapshot(payload.spaceId);
    if (!snap?.scheduledAt) return;
    if (snap.scheduledAt.getTime() !== payload.scheduledAtMs) return;
    if (snap.scheduledAt.getTime() <= Date.now()) return;
    if (
      payload.kind === 'space_reminder_day' &&
      !this.spaces.isDayReminderStillValid(snap.scheduledAt, payload.scheduledAtMs)
    ) {
      return;
    }

    const isDay = payload.kind === 'space_reminder_day';
    // Host gets the 30-min heads-up — not the morning "today" ping.
    const audience = isDay
      ? (await this.spaces.listSubscriberUserIds(payload.spaceId)).filter((id) => id !== snap.ownerUserId)
      : this.uniqueRecipientIds(
          [...(await this.spaces.listAudienceUserIds(payload.spaceId, snap.ownerUserId)), snap.ownerUserId],
        );
    if (audience.length === 0) return;

    const when = formatScheduleWhen(snap.scheduledAt);
    const eventTitle = snap.eventTitle || snap.title;
    const title = isDay ? `${eventTitle} today` : `${eventTitle} starting soon`;
    const body = isDay
      ? when
        ? `Scheduled for ${when}.`
        : 'A space you asked about is today.'
      : 'Starts in about 30 minutes.';
    const emailCfg = this.appConfig.email();
    const ctx = this.spaceEmailContext({
      ownerUsername: snap.ownerUsername,
      eventTitle,
    });

    await runInBatches(audience, FANOUT_CONCURRENCY, async (recipientUserId) => {
      await this.notifications.upsertSpaceScheduleNotification({
        recipientUserId,
        kind: payload.kind,
        spaceId: payload.spaceId,
        actorUserId: snap.ownerUserId,
        title,
        body,
      });
      if (isDay || !emailCfg || recipientUserId === snap.ownerUserId) return;
      await this.sendSpaceEmail({
        recipientUserId,
        hostName: ctx.hostName,
        spaceTitle: eventTitle,
        whenLabel: when,
        spaceUrl: ctx.spaceUrl,
        kind: 'soon',
        ...this.spaceEmailMedia(snap),
      });
    });
  }
}

function frontendBase(raw: string | null): string {
  return ((raw ?? '').trim() || 'https://menofhunger.com').replace(/\/$/, '');
}
