import { Injectable, NotFoundException, ForbiddenException, ConflictException, BadRequestException } from '@nestjs/common';
import type { SpaceMode } from '@prisma/client';
import type { SpaceDto, SpaceOwnerDto, SpaceReactionDto, SpacesUpdatedPatchDto } from '../../common/dto';
import { ALLOWED_REACTIONS, findReactionById } from '../../common/constants/reactions';
import { publicAssetUrl } from '../../common/assets/public-asset-url';
import { easternDayKey, etLocalToUtcMs } from '../../common/time/eastern-day-key';
import { PrismaService } from '../prisma/prisma.service';
import { AppConfigService } from '../app/app-config.service';
import { SpacesPresenceService } from './spaces-presence.service';
import { SideEffectsService } from '../side-effects/side-effects.service';
import { FANOUT_CONCURRENCY, runInBatches } from '../side-effects/batch';
import { JobsService } from '../jobs/jobs.service';
import { JOBS } from '../jobs/jobs.constants';
import { NotificationsService } from '../notifications/notifications.service';
import { PresenceRealtimeService } from '../presence/presence-realtime.service';
import { LinkMetadataService } from '../link-metadata/link-metadata.service';
import { PosthogService } from '../../common/posthog/posthog.service';
import { compareLobbySpaces } from './spaces-lobby-sort';
import { resolveSpacePlaybackTitle } from './spaces-playback-title';
import { fetchYouTubeOEmbedTitle } from './youtube-oembed-title';

const SOON_MS = 15 * 60 * 1000;

function dayReminderJobId(spaceId: string, scheduledAtMs: number): string {
  return `space-reminder-day-${spaceId}-${scheduledAtMs}`;
}

function soonReminderJobId(spaceId: string, scheduledAtMs: number): string {
  return `space-reminder-soon-${spaceId}-${scheduledAtMs}`;
}

@Injectable()
export class SpacesService {
  private readonly r2PublicBaseUrl: string;

  constructor(
    private readonly prisma: PrismaService,
    private readonly appConfig: AppConfigService,
    private readonly spacesPresence: SpacesPresenceService,
    private readonly sideEffects: SideEffectsService,
    private readonly jobs: JobsService,
    private readonly realtime: PresenceRealtimeService,
    private readonly notifications: NotificationsService,
    private readonly linkMetadata: LinkMetadataService,
    private readonly posthog: PosthogService,
  ) {
    this.r2PublicBaseUrl = this.appConfig.r2()?.publicBaseUrl ?? '';
  }

  async createSpace(userId: string, data: { title: string; description?: string | null }): Promise<SpaceDto> {
    const existing = await this.prisma.space.findUnique({ where: { ownerId: userId } });
    if (existing) throw new ConflictException('You already have a space.');

    const space = await this.prisma.space.create({
      data: {
        ownerId: userId,
        title: data.title,
        description: data.description ?? null,
      },
      include: { owner: true, _count: { select: { scheduleSubscribers: true } } },
    });

    const dto = await this.toDto(space, { viewerUserId: userId });
    this.posthog.capture(userId, 'space_created', { space_id: space.id });
    return dto;
  }

  async getSpaceById(id: string, viewerUserId?: string | null): Promise<SpaceDto> {
    const space = await this.prisma.space.findUnique({
      where: { id },
      include: { owner: true, _count: { select: { scheduleSubscribers: true } } },
    });
    if (!space) throw new NotFoundException();
    await this.ensureOwnerSubscribedIfScheduled(space);
    return this.toDto(space, {
      viewerUserId,
      subscriberCountOverride: await this.countNonOwnerSubscribers(space.id, space.ownerId),
    });
  }

  async getSpaceByOwnerUsername(username: string, viewerUserId?: string | null): Promise<SpaceDto> {
    const user = await this.prisma.user.findFirst({
      where: { username: { equals: username, mode: 'insensitive' } },
      select: { id: true },
    });
    if (!user) throw new NotFoundException();

    const space = await this.prisma.space.findUnique({
      where: { ownerId: user.id },
      include: { owner: true, _count: { select: { scheduleSubscribers: true } } },
    });
    if (!space) throw new NotFoundException();
    await this.ensureOwnerSubscribedIfScheduled(space);
    return this.toDto(space, {
      viewerUserId,
      subscriberCountOverride: await this.countNonOwnerSubscribers(space.id, space.ownerId),
    });
  }

  async getSpaceByOwnerId(ownerId: string, viewerUserId?: string | null): Promise<SpaceDto | null> {
    const space = await this.prisma.space.findUnique({
      where: { ownerId },
      include: { owner: true, _count: { select: { scheduleSubscribers: true } } },
    });
    if (!space) return null;
    await this.ensureOwnerSubscribedIfScheduled(space);
    return this.toDto(space, {
      viewerUserId,
      subscriberCountOverride: await this.countNonOwnerSubscribers(space.id, space.ownerId),
    });
  }

  async getOwnerIdForSpace(spaceId: string): Promise<string | null> {
    const space = await this.prisma.space.findUnique({
      where: { id: spaceId },
      select: { ownerId: true },
    });
    return space?.ownerId ?? null;
  }

  async updateSpace(id: string, userId: string, data: { title?: string; description?: string | null }): Promise<SpaceDto> {
    const space = await this.prisma.space.findUnique({ where: { id }, select: { ownerId: true } });
    if (!space) throw new NotFoundException();
    if (space.ownerId !== userId) throw new ForbiddenException();

    const updated = await this.prisma.space.update({
      where: { id },
      data: {
        ...(data.title !== undefined ? { title: data.title } : {}),
        ...(data.description !== undefined ? { description: data.description } : {}),
      },
      include: { owner: true, _count: { select: { scheduleSubscribers: true } } },
    });

    const dto = await this.toDto(updated, { viewerUserId: userId });
    this.emitSpaceUpdated(id, 'updated', {
      title: dto.title,
      description: dto.description,
    });
    return dto;
  }

  async deleteSpace(id: string, userId: string): Promise<void> {
    const space = await this.prisma.space.findUnique({
      where: { id },
      select: {
        ownerId: true,
        title: true,
        scheduledAt: true,
        owner: { select: { username: true } },
      },
    });
    if (!space) throw new NotFoundException();
    if (space.ownerId !== userId) throw new ForbiddenException();

    // Cancel-on-delete must write while the space row still exists (subjectSpaceId FK
    // + push deep-link lookup). clearSchedule keeps the async side-effect path.
    if (space.scheduledAt) {
      const recipientUserIds = (await this.listSubscriberUserIds(id)).filter(
        (uid) => uid !== space.ownerId,
      );
      await this.cancelReminderJobs(id, space.scheduledAt.getTime());
      const title = `${space.title} cancelled`;
      const body = 'The scheduled space was cancelled.';
      await runInBatches(recipientUserIds, FANOUT_CONCURRENCY, async (recipientUserId) => {
        await this.notifications.upsertSpaceScheduleNotification({
          recipientUserId,
          kind: 'space_schedule_cancelled',
          spaceId: id,
          actorUserId: space.ownerId,
          title,
          body,
        });
      });
    }

    // Quiet "was live" retitle must land while the Space row still exists —
    // deleting SET NULLs subjectSpaceId, so an async ended job would miss the rows.
    const liveRecipientIds = await this.notifications.listRecipientIdsForSpaceNotification({
      spaceId: id,
      kind: 'space_live',
    });
    if (liveRecipientIds.length > 0) {
      const title = `${space.title} was live`;
      const body = "It's no longer live.";
      await runInBatches(liveRecipientIds, FANOUT_CONCURRENCY, async (recipientUserId) => {
        await this.notifications.upsertSpaceScheduleNotification({
          recipientUserId,
          kind: 'space_live',
          spaceId: id,
          actorUserId: space.ownerId,
          title,
          body,
          resurface: false,
        });
      });
    }

    await this.prisma.space.delete({ where: { id } });
    this.emitSpaceUpdated(id, 'deleted', { deleted: true });
    this.posthog.capture(userId, 'space_deleted', { space_id: id });
  }

  async activateSpace(id: string, userId: string): Promise<SpaceDto> {
    const space = await this.prisma.space.findUnique({
      where: { id },
      select: { ownerId: true, scheduledAt: true, mode: true },
    });
    if (!space) throw new NotFoundException();
    if (space.ownerId !== userId) throw new ForbiddenException();

    const previousScheduledAt = space.scheduledAt;
    const updated = await this.prisma.space.update({
      where: { id },
      data: { isActive: true, scheduledAt: null, activatedAt: new Date() },
      include: { owner: true, _count: { select: { scheduleSubscribers: true } } },
    });

    if (previousScheduledAt) {
      await this.cancelReminderJobs(id, previousScheduledAt.getTime());
    }
    // Snapshot Notify-me recipients before clearing them. The handler also unions
    // anyone who already has a space_live row (go-live-again with no new schedule).
    const recipientUserIds = previousScheduledAt
      ? (await this.listSubscriberUserIds(id)).filter((uid) => uid !== userId)
      : [];
    this.sideEffects.dispatch('space.schedule.live', { spaceId: id, recipientUserIds });
    await this.clearNonOwnerSubscribers(id, userId);

    const dto = await this.toDto(updated, {
      viewerUserId: userId,
      subscriberCountOverride: await this.countNonOwnerSubscribers(id, userId),
    });
    this.emitSpaceUpdated(id, 'activated', {
      isActive: true,
      scheduledAt: null,
      subscriberCount: dto.subscriberCount,
      playbackTitle: dto.playbackTitle,
    });
    this.posthog.capture(userId, 'space_activated', {
      space_id: id,
      mode: dto.mode,
      had_schedule: Boolean(previousScheduledAt),
    });
    return dto;
  }

  async deactivateSpace(id: string, userId: string): Promise<SpaceDto> {
    const space = await this.prisma.space.findUnique({ where: { id }, select: { ownerId: true } });
    if (!space) throw new NotFoundException();
    if (space.ownerId !== userId) throw new ForbiddenException();

    const updated = await this.prisma.space.update({
      where: { id },
      data: { isActive: false },
      include: { owner: true, _count: { select: { scheduleSubscribers: true } } },
    });
    const dto = await this.toDto(updated, { viewerUserId: userId });
    this.emitSpaceUpdated(id, 'deactivated', { isActive: false });
    this.sideEffects.dispatch('space.schedule.ended', { spaceId: id });
    this.posthog.capture(userId, 'space_deactivated', {
      space_id: id,
      mode: dto.mode,
      reason: 'owner',
    });
    return dto;
  }

  /**
   * System path: flip an abandoned live space offline (owner left / empty lobby sweep).
   * Returns true when a row was updated.
   */
  async deactivateIfActive(spaceId: string): Promise<boolean> {
    const id = String(spaceId ?? '').trim();
    if (!id) return false;
    const result = await this.prisma.space.updateMany({
      where: { id, isActive: true },
      data: { isActive: false },
    });
    if (result.count > 0) {
      this.emitSpaceUpdated(id, 'deactivated', { isActive: false });
      this.sideEffects.dispatch('space.schedule.ended', { spaceId: id });
      const row = await this.prisma.space.findUnique({
        where: { id },
        select: { ownerId: true, mode: true },
      });
      if (row) {
        this.posthog.capture(row.ownerId, 'space_deactivated', {
          space_id: id,
          mode: row.mode,
          reason: 'idle',
        });
      }
    }
    return result.count > 0;
  }

  async setMode(
    id: string,
    userId: string,
    data: { mode: SpaceMode; watchPartyUrl?: string | null; radioStreamUrl?: string | null },
  ): Promise<SpaceDto> {
    const space = await this.prisma.space.findUnique({
      where: { id },
      select: { ownerId: true, mode: true },
    });
    if (!space) throw new NotFoundException();
    if (space.ownerId !== userId) throw new ForbiddenException();

    if (data.mode === 'WATCH_PARTY' && !data.watchPartyUrl?.trim()) {
      throw new BadRequestException('A YouTube URL is required for watch party mode.');
    }
    if (data.mode === 'RADIO' && !data.radioStreamUrl?.trim()) {
      throw new BadRequestException('A stream URL is required for radio mode.');
    }

    const updated = await this.prisma.space.update({
      where: { id },
      data: {
        mode: data.mode,
        watchPartyUrl: data.mode === 'WATCH_PARTY' ? (data.watchPartyUrl?.trim() ?? null) : null,
        radioStreamUrl: data.mode === 'RADIO' ? (data.radioStreamUrl?.trim() ?? null) : null,
      },
      include: { owner: true, _count: { select: { scheduleSubscribers: true } } },
    });
    const dto = await this.toDto(updated, { viewerUserId: userId });
    this.emitSpaceUpdated(id, 'mode_changed', {
      mode: dto.mode,
      watchPartyUrl: dto.watchPartyUrl,
      radioStreamUrl: dto.radioStreamUrl,
      playbackTitle: dto.playbackTitle,
    });
    this.posthog.capture(userId, 'space_mode_set', {
      space_id: id,
      mode: dto.mode,
      from_mode: space.mode,
      has_watch_party_url: Boolean(dto.watchPartyUrl),
      has_radio_url: Boolean(dto.radioStreamUrl),
    });
    return dto;
  }

  async setSchedule(id: string, userId: string, scheduledAtRaw: string): Promise<SpaceDto> {
    const space = await this.prisma.space.findUnique({
      where: { id },
      select: { ownerId: true, scheduledAt: true },
    });
    if (!space) throw new NotFoundException();
    if (space.ownerId !== userId) throw new ForbiddenException();

    const scheduledAt = new Date(scheduledAtRaw);
    if (Number.isNaN(scheduledAt.getTime())) {
      throw new BadRequestException('Invalid schedule time.');
    }
    if (scheduledAt.getTime() <= Date.now() + 60_000) {
      throw new BadRequestException('Schedule time must be at least one minute in the future.');
    }

    const previousMs = space.scheduledAt?.getTime() ?? null;
    const updated = await this.prisma.space.update({
      where: { id },
      data: { scheduledAt },
      include: { owner: true, _count: { select: { scheduleSubscribers: true } } },
    });

    // Host gets the ~15 min heads-up (not day-of / live — see side-effects handler).
    await this.ensureOwnerScheduleSubscription(id, userId);

    if (previousMs != null) {
      await this.cancelReminderJobs(id, previousMs);
    }
    await this.enqueueReminderJobs(id, scheduledAt);

    if (previousMs != null && previousMs !== scheduledAt.getTime()) {
      this.sideEffects.dispatch('space.schedule.rescheduled', {
        spaceId: id,
        scheduledAt: scheduledAt.toISOString(),
      });
    }

    const dto = await this.toDto(updated, {
      viewerUserId: userId,
      viewerSubscribedOverride: true,
      subscriberCountOverride: await this.countNonOwnerSubscribers(id, userId),
    });
    this.emitSpaceUpdated(id, 'schedule_set', {
      scheduledAt: dto.scheduledAt,
      isActive: dto.isActive,
      subscriberCount: dto.subscriberCount,
    });
    this.posthog.capture(userId, 'space_schedule_set', {
      space_id: id,
      scheduled_at: dto.scheduledAt,
      is_reschedule: previousMs != null,
    });
    return dto;
  }

  async clearSchedule(id: string, userId: string): Promise<SpaceDto> {
    const space = await this.prisma.space.findUnique({
      where: { id },
      select: {
        ownerId: true,
        title: true,
        scheduledAt: true,
        owner: { select: { username: true } },
      },
    });
    if (!space) throw new NotFoundException();
    if (space.ownerId !== userId) throw new ForbiddenException();

    if (!space.scheduledAt) {
      return this.getSpaceById(id, userId);
    }

    const previousMs = space.scheduledAt.getTime();
    const updated = await this.prisma.space.update({
      where: { id },
      data: { scheduledAt: null },
      include: { owner: true, _count: { select: { scheduleSubscribers: true } } },
    });

    await this.cancelReminderJobs(id, previousMs);
    this.sideEffects.dispatch('space.schedule.cancelled', {
      spaceId: id,
      ownerUserId: space.ownerId,
      spaceTitle: space.title,
      ownerUsername: space.owner.username,
    });
    await this.clearNonOwnerSubscribers(id, userId);

    const dto = await this.toDto(updated, {
      viewerUserId: userId,
      subscriberCountOverride: await this.countNonOwnerSubscribers(id, userId),
    });
    this.emitSpaceUpdated(id, 'schedule_cleared', {
      scheduledAt: null,
      subscriberCount: dto.subscriberCount,
    });
    this.posthog.capture(userId, 'space_schedule_cleared', { space_id: id });
    return dto;
  }

  async subscribeToSchedule(id: string, userId: string): Promise<SpaceDto> {
    const space = await this.prisma.space.findUnique({
      where: { id },
      select: { id: true, ownerId: true, scheduledAt: true },
    });
    if (!space) throw new NotFoundException();
    if (!space.scheduledAt || space.scheduledAt.getTime() <= Date.now()) {
      throw new BadRequestException('This space has no upcoming schedule.');
    }

    // Owner is already auto-subscribed on setSchedule; treat as idempotent.
    const existing = await this.prisma.spaceScheduleSubscriber.findUnique({
      where: { spaceId_userId: { spaceId: id, userId } },
      select: { id: true },
    });
    await this.prisma.spaceScheduleSubscriber.upsert({
      where: { spaceId_userId: { spaceId: id, userId } },
      create: { spaceId: id, userId },
      update: {},
    });

    const dto = await this.getSpaceById(id, userId);
    this.emitSpaceUpdated(id, 'schedule_subscribe', { subscriberCount: dto.subscriberCount });
    if (!existing && space.ownerId !== userId) {
      this.posthog.capture(userId, 'space_schedule_subscribed', { space_id: id });
    }
    return dto;
  }

  async unsubscribeFromSchedule(id: string, userId: string): Promise<SpaceDto> {
    const space = await this.prisma.space.findUnique({
      where: { id },
      select: { id: true, ownerId: true },
    });
    if (!space) throw new NotFoundException();
    if (space.ownerId === userId) {
      throw new BadRequestException('Host reminders stay on for your scheduled space.');
    }

    const removed = await this.prisma.spaceScheduleSubscriber.deleteMany({
      where: { spaceId: id, userId },
    });

    const dto = await this.getSpaceById(id, userId);
    this.emitSpaceUpdated(id, 'schedule_unsubscribe', { subscriberCount: dto.subscriberCount });
    if (removed.count > 0) {
      this.posthog.capture(userId, 'space_schedule_unsubscribed', { space_id: id });
    }
    return dto;
  }

  /** Lobby: live + occupied + upcoming scheduled + viewer's own space (even if offline). */
  async listLobbySpaces(viewerUserId?: string | null): Promise<SpaceDto[]> {
    const now = new Date();
    const viewerId = String(viewerUserId ?? '').trim() || null;
    const counts = this.spacesPresence.getLobbyCountsBySpaceId();
    const occupiedIds = Object.entries(counts)
      .filter(([, n]) => Number(n) > 0)
      .map(([id]) => id);
    const or: Array<
      { isActive: true } | { scheduledAt: { gt: Date } } | { ownerId: string } | { id: { in: string[] } }
    > = [{ isActive: true }, { scheduledAt: { gt: now } }];
    if (viewerId) or.push({ ownerId: viewerId });
    if (occupiedIds.length > 0) or.push({ id: { in: occupiedIds } });

    const spaces = await this.prisma.space.findMany({
      where: { OR: or },
      include: { owner: true, _count: { select: { scheduleSubscribers: true } } },
      orderBy: { createdAt: 'desc' },
    });

    // Backfill host auto-subscribe for any upcoming schedule (covers spaces scheduled
    // before host reminders were automatic).
    const upcoming = spaces.filter((s) => s.scheduledAt != null && s.scheduledAt.getTime() > now.getTime());
    if (upcoming.length > 0) {
      await this.prisma.spaceScheduleSubscriber.createMany({
        data: upcoming.map((s) => ({ spaceId: s.id, userId: s.ownerId })),
        skipDuplicates: true,
      });
    }

    const spaceIds = spaces.map((s) => s.id);
    const ownerIds = [...new Set(spaces.map((s) => s.ownerId))];

    const [allSubRows, followRows] = await Promise.all([
      spaceIds.length > 0
        ? this.prisma.spaceScheduleSubscriber.findMany({
            where: { spaceId: { in: spaceIds } },
            select: { spaceId: true, userId: true },
          })
        : Promise.resolve([] as Array<{ spaceId: string; userId: string }>),
      viewerId && ownerIds.length > 0
        ? this.prisma.follow.findMany({
            where: { followerId: viewerId, followingId: { in: ownerIds } },
            select: { followingId: true },
          })
        : Promise.resolve([] as Array<{ followingId: string }>),
    ]);

    const subscribedIds = new Set<string>();
    const ownerBySpaceId = new Map(spaces.map((s) => [s.id, s.ownerId]));
    const nonOwnerCountBySpaceId = new Map<string, number>();
    for (const row of allSubRows) {
      if (viewerId && row.userId === viewerId) subscribedIds.add(row.spaceId);
      if (row.userId === ownerBySpaceId.get(row.spaceId)) continue;
      nonOwnerCountBySpaceId.set(row.spaceId, (nonOwnerCountBySpaceId.get(row.spaceId) ?? 0) + 1);
    }

    const followingOwnerIds = new Set(followRows.map((r) => r.followingId));

    const dtos = await Promise.all(
      spaces.map((s) =>
        this.toDto(s, {
          viewerUserId: viewerId,
          listenerCountOverride: counts[s.id],
          viewerSubscribedOverride: subscribedIds.has(s.id),
          subscriberCountOverride: nonOwnerCountBySpaceId.get(s.id) ?? 0,
          viewerFollowsOwnerOverride: Boolean(
            viewerId && s.ownerId !== viewerId && followingOwnerIds.has(s.ownerId),
          ),
        }),
      ),
    );

    return dtos.sort((a, b) => compareLobbySpaces(a, b, { viewerId, followingOwnerIds }));
  }

  async isSpaceActive(spaceId: string): Promise<boolean> {
    const space = await this.prisma.space.findUnique({
      where: { id: spaceId },
      select: { isActive: true },
    });
    return space?.isActive ?? false;
  }

  async getSpaceMode(spaceId: string): Promise<SpaceMode | null> {
    const space = await this.prisma.space.findUnique({
      where: { id: spaceId },
      select: { mode: true },
    });
    return space?.mode ?? null;
  }

  listReactions(): SpaceReactionDto[] {
    return [...ALLOWED_REACTIONS];
  }

  getReactionById(reactionIdRaw: string): SpaceReactionDto | null {
    return findReactionById(String(reactionIdRaw ?? ''));
  }

  async enqueueReminderJobs(spaceId: string, scheduledAt: Date): Promise<void> {
    const scheduledAtMs = scheduledAt.getTime();
    const now = Date.now();
    const soonAt = scheduledAtMs - SOON_MS;
    const dayAt = etLocalToUtcMs(scheduledAt, 9, 0);

    // Day-of at 09:00 ET — skip if that instant is after the 15-min window or already past.
    if (dayAt > now && dayAt <= soonAt) {
      const delay = Math.max(0, dayAt - now);
      try {
        await this.jobs.enqueue(
          JOBS.spaceReminderDay,
          { spaceId, scheduledAtMs },
          {
            jobId: dayReminderJobId(spaceId, scheduledAtMs),
            delay,
            removeOnComplete: true,
            removeOnFail: true,
          },
        );
      } catch {
        // Duplicate jobId — ignore.
      }
    }

    if (soonAt > now) {
      try {
        await this.jobs.enqueue(
          JOBS.spaceReminderSoon,
          { spaceId, scheduledAtMs },
          {
            jobId: soonReminderJobId(spaceId, scheduledAtMs),
            delay: Math.max(0, soonAt - now),
            removeOnComplete: true,
            removeOnFail: true,
          },
        );
      } catch {
        // Duplicate jobId — ignore.
      }
    }
  }

  async cancelReminderJobs(spaceId: string, scheduledAtMs: number): Promise<void> {
    await this.jobs.removeById(JOBS.spaceReminderDay, dayReminderJobId(spaceId, scheduledAtMs));
    await this.jobs.removeById(JOBS.spaceReminderSoon, soonReminderJobId(spaceId, scheduledAtMs));
  }

  /** Used by reminder jobs / side-effects — re-check schedule still matches. */
  async getScheduleSnapshot(spaceId: string): Promise<{
    scheduledAt: Date | null;
    title: string;
    ownerUserId: string;
    ownerUsername: string | null;
  } | null> {
    const space = await this.prisma.space.findUnique({
      where: { id: spaceId },
      select: {
        scheduledAt: true,
        title: true,
        ownerId: true,
        owner: { select: { username: true } },
      },
    });
    if (!space) return null;
    return {
      scheduledAt: space.scheduledAt,
      title: space.title,
      ownerUserId: space.ownerId,
      ownerUsername: space.owner.username,
    };
  }

  async listSubscriberUserIds(spaceId: string): Promise<string[]> {
    const rows = await this.prisma.spaceScheduleSubscriber.findMany({
      where: { spaceId },
      select: { userId: true },
    });
    return rows.map((r) => r.userId);
  }

  /** Host is always on the reminder list for an upcoming schedule. */
  private async ensureOwnerScheduleSubscription(spaceId: string, ownerId: string): Promise<void> {
    await this.prisma.spaceScheduleSubscriber.upsert({
      where: { spaceId_userId: { spaceId, userId: ownerId } },
      create: { spaceId, userId: ownerId },
      update: {},
    });
  }

  private async ensureOwnerSubscribedIfScheduled(space: {
    id: string;
    ownerId: string;
    scheduledAt: Date | null;
  }): Promise<void> {
    if (!space.scheduledAt || space.scheduledAt.getTime() <= Date.now()) return;
    await this.ensureOwnerScheduleSubscription(space.id, space.ownerId);
  }

  /** Day-of reminder still valid for this schedule instant? */
  isDayReminderStillValid(scheduledAt: Date, scheduledAtMs: number, now = Date.now()): boolean {
    if (scheduledAt.getTime() !== scheduledAtMs) return false;
    if (scheduledAtMs <= now) return false;
    const dayAt = etLocalToUtcMs(scheduledAt, 9, 0);
    const soonAt = scheduledAtMs - SOON_MS;
    // Fire only if we're at/after the day slot conceptually; job already delayed to dayAt.
    // Skip if day slot would have been after the soon window (should not have been enqueued).
    if (dayAt > soonAt) return false;
    // Same ET calendar day as scheduled.
    return easternDayKey(new Date(now)) === easternDayKey(scheduledAt) || now >= dayAt;
  }

  private async toDto(
    space: {
      id: string;
      title: string;
      description: string | null;
      isActive: boolean;
      scheduledAt: Date | null;
      mode: SpaceMode;
      watchPartyUrl: string | null;
      radioStreamUrl: string | null;
      owner: {
        id: string;
        username: string | null;
        avatarKey: string | null;
        avatarUpdatedAt: Date | null;
        premium: boolean;
        premiumPlus: boolean;
        isOrganization: boolean;
        verifiedStatus: 'none' | 'identity' | 'manual';
      };
      _count?: { scheduleSubscribers: number };
    },
    opts?: {
      viewerUserId?: string | null;
      listenerCountOverride?: number;
      viewerSubscribedOverride?: boolean;
      subscriberCountOverride?: number;
      viewerFollowsOwnerOverride?: boolean;
    },
  ): Promise<SpaceDto> {
    const owner: SpaceOwnerDto = {
      id: space.owner.id,
      username: space.owner.username,
      avatarUrl: publicAssetUrl({
        publicBaseUrl: this.r2PublicBaseUrl,
        key: space.owner.avatarKey,
        updatedAt: space.owner.avatarUpdatedAt,
      }),
      premium: space.owner.premium,
      premiumPlus: space.owner.premiumPlus,
      isOrganization: space.owner.isOrganization,
      verifiedStatus: space.owner.verifiedStatus,
    };

    const listenerCount =
      opts?.listenerCountOverride ?? (this.spacesPresence.getLobbyCountsBySpaceId()[space.id] ?? 0);

    let viewerSubscribed = opts?.viewerSubscribedOverride ?? false;
    if (opts?.viewerSubscribedOverride === undefined && opts?.viewerUserId) {
      const row = await this.prisma.spaceScheduleSubscriber.findUnique({
        where: { spaceId_userId: { spaceId: space.id, userId: opts.viewerUserId } },
        select: { userId: true },
      });
      viewerSubscribed = Boolean(row);
    }

    let viewerFollowsOwner = opts?.viewerFollowsOwnerOverride ?? false;
    if (
      opts?.viewerFollowsOwnerOverride === undefined &&
      opts?.viewerUserId &&
      opts.viewerUserId !== space.owner.id
    ) {
      const follow = await this.prisma.follow.findUnique({
        where: {
          followerId_followingId: {
            followerId: opts.viewerUserId,
            followingId: space.owner.id,
          },
        },
        select: { followerId: true },
      });
      viewerFollowsOwner = Boolean(follow);
    }

    const subscriberCount =
      opts?.subscriberCountOverride ??
      (await this.countNonOwnerSubscribers(space.id, space.owner.id));

    const playbackTitle = await resolveSpacePlaybackTitle({
      mode: space.mode,
      watchPartyUrl: space.watchPartyUrl,
      radioStreamUrl: space.radioStreamUrl,
      getLinkTitle: async (url) => {
        const youtubeTitle = await fetchYouTubeOEmbedTitle(url);
        if (youtubeTitle) return youtubeTitle;
        const meta = await this.linkMetadata.getMetadata(url);
        const title = meta?.title?.trim();
        return title || null;
      },
    });

    return {
      id: space.id,
      title: space.title,
      description: space.description,
      isActive: space.isActive,
      scheduledAt: space.scheduledAt ? space.scheduledAt.toISOString() : null,
      mode: space.mode,
      watchPartyUrl: space.watchPartyUrl,
      radioStreamUrl: space.radioStreamUrl,
      playbackTitle,
      owner,
      listenerCount,
      viewerSubscribed,
      subscriberCount,
      viewerFollowsOwner,
    };
  }

  /** Notify-me rows for non-hosts; host stays subscribed for soon reminders while scheduled. */
  private async clearNonOwnerSubscribers(spaceId: string, ownerId: string): Promise<void> {
    await this.prisma.spaceScheduleSubscriber.deleteMany({
      where: { spaceId, userId: { not: ownerId } },
    });
  }

  async countNonOwnerSubscribers(spaceId: string, ownerId: string): Promise<number> {
    return this.prisma.spaceScheduleSubscriber.count({
      where: { spaceId, userId: { not: ownerId } },
    });
  }

  /** Lobby room only — viewer-agnostic patch (no viewerSubscribed / viewerFollowsOwner). */
  private emitSpaceUpdated(spaceId: string, reason: string, patch: SpacesUpdatedPatchDto): void {
    this.realtime.emitSpacesUpdated({
      spaceId,
      version: new Date().toISOString(),
      reason,
      patch,
    });
  }
}
