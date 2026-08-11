import { Injectable, NotFoundException, ForbiddenException, ConflictException, BadRequestException } from '@nestjs/common';
import type { SpaceMode } from '@prisma/client';
import type { SpaceDto, SpaceOwnerDto, SpaceReactionDto } from '../../common/dto';
import { ALLOWED_REACTIONS, findReactionById } from '../../common/constants/reactions';
import { publicAssetUrl } from '../../common/assets/public-asset-url';
import { easternDayKey, etLocalToUtcMs } from '../../common/time/eastern-day-key';
import { PrismaService } from '../prisma/prisma.service';
import { AppConfigService } from '../app/app-config.service';
import { SpacesPresenceService } from './spaces-presence.service';
import { SideEffectsService } from '../side-effects/side-effects.service';
import { JobsService } from '../jobs/jobs.service';
import { JOBS } from '../jobs/jobs.constants';

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

    return this.toDto(space, { viewerUserId: userId });
  }

  async getSpaceById(id: string, viewerUserId?: string | null): Promise<SpaceDto> {
    const space = await this.prisma.space.findUnique({
      where: { id },
      include: { owner: true, _count: { select: { scheduleSubscribers: true } } },
    });
    if (!space) throw new NotFoundException();
    return this.toDto(space, { viewerUserId });
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
    return this.toDto(space, { viewerUserId });
  }

  async getSpaceByOwnerId(ownerId: string, viewerUserId?: string | null): Promise<SpaceDto | null> {
    const space = await this.prisma.space.findUnique({
      where: { ownerId },
      include: { owner: true, _count: { select: { scheduleSubscribers: true } } },
    });
    if (!space) return null;
    return this.toDto(space, { viewerUserId });
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

    return this.toDto(updated, { viewerUserId: userId });
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

    if (space.scheduledAt) {
      const recipientUserIds = await this.listSubscriberUserIds(id);
      await this.cancelReminderJobs(id, space.scheduledAt.getTime());
      this.sideEffects.dispatch('space.schedule.cancelled', {
        spaceId: id,
        ownerUserId: space.ownerId,
        spaceTitle: space.title,
        ownerUsername: space.owner.username,
        recipientUserIds,
      });
    }

    await this.prisma.space.delete({ where: { id } });
  }

  async activateSpace(id: string, userId: string): Promise<SpaceDto> {
    const space = await this.prisma.space.findUnique({
      where: { id },
      select: { ownerId: true, scheduledAt: true },
    });
    if (!space) throw new NotFoundException();
    if (space.ownerId !== userId) throw new ForbiddenException();

    const previousScheduledAt = space.scheduledAt;
    const updated = await this.prisma.space.update({
      where: { id },
      data: { isActive: true, scheduledAt: null },
      include: { owner: true, _count: { select: { scheduleSubscribers: true } } },
    });

    if (previousScheduledAt) {
      await this.cancelReminderJobs(id, previousScheduledAt.getTime());
    }
    this.sideEffects.dispatch('space.schedule.live', { spaceId: id });

    return this.toDto(updated, { viewerUserId: userId });
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
    return this.toDto(updated, { viewerUserId: userId });
  }

  async activateSpaceByOwnerId(ownerId: string): Promise<void> {
    const space = await this.prisma.space.findUnique({
      where: { ownerId },
      select: { id: true, isActive: true, scheduledAt: true },
    });
    if (!space || space.isActive) return;

    const previousScheduledAt = space.scheduledAt;
    await this.prisma.space.update({
      where: { id: space.id },
      data: { isActive: true, scheduledAt: null },
    });
    if (previousScheduledAt) {
      await this.cancelReminderJobs(space.id, previousScheduledAt.getTime());
    }
    this.sideEffects.dispatch('space.schedule.live', { spaceId: space.id });
  }

  async setMode(
    id: string,
    userId: string,
    data: { mode: SpaceMode; watchPartyUrl?: string | null; radioStreamUrl?: string | null },
  ): Promise<SpaceDto> {
    const space = await this.prisma.space.findUnique({ where: { id }, select: { ownerId: true } });
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
    return this.toDto(updated, { viewerUserId: userId });
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

    return this.toDto(updated, { viewerUserId: userId });
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

    return this.toDto(updated, { viewerUserId: userId });
  }

  async subscribeToSchedule(id: string, userId: string): Promise<SpaceDto> {
    const space = await this.prisma.space.findUnique({
      where: { id },
      select: { id: true, ownerId: true, scheduledAt: true },
    });
    if (!space) throw new NotFoundException();
    if (space.ownerId === userId) {
      throw new BadRequestException('You cannot subscribe to your own space schedule.');
    }
    if (!space.scheduledAt || space.scheduledAt.getTime() <= Date.now()) {
      throw new BadRequestException('This space has no upcoming schedule.');
    }

    await this.prisma.spaceScheduleSubscriber.upsert({
      where: { spaceId_userId: { spaceId: id, userId } },
      create: { spaceId: id, userId },
      update: {},
    });

    return this.getSpaceById(id, userId);
  }

  async unsubscribeFromSchedule(id: string, userId: string): Promise<SpaceDto> {
    const space = await this.prisma.space.findUnique({ where: { id }, select: { id: true } });
    if (!space) throw new NotFoundException();

    await this.prisma.spaceScheduleSubscriber.deleteMany({
      where: { spaceId: id, userId },
    });

    return this.getSpaceById(id, userId);
  }

  /** Lobby: live spaces + upcoming scheduled spaces. */
  async listLobbySpaces(viewerUserId?: string | null): Promise<SpaceDto[]> {
    const now = new Date();
    const spaces = await this.prisma.space.findMany({
      where: {
        OR: [{ isActive: true }, { scheduledAt: { gt: now } }],
      },
      include: { owner: true, _count: { select: { scheduleSubscribers: true } } },
      orderBy: { createdAt: 'desc' },
    });

    const counts = this.spacesPresence.getLobbyCountsBySpaceId();
    const subscribedIds = viewerUserId
      ? new Set(
          (
            await this.prisma.spaceScheduleSubscriber.findMany({
              where: { userId: viewerUserId, spaceId: { in: spaces.map((s) => s.id) } },
              select: { spaceId: true },
            })
          ).map((r) => r.spaceId),
        )
      : new Set<string>();

    const dtos = await Promise.all(
      spaces.map((s) =>
        this.toDto(s, {
          viewerUserId,
          listenerCountOverride: counts[s.id],
          viewerSubscribedOverride: subscribedIds.has(s.id),
        }),
      ),
    );

    return dtos.sort((a, b) => {
      if (a.isActive !== b.isActive) return a.isActive ? -1 : 1;
      if (a.isActive && b.isActive) return b.listenerCount - a.listenerCount;
      const aAt = a.scheduledAt ? Date.parse(a.scheduledAt) : Number.POSITIVE_INFINITY;
      const bAt = b.scheduledAt ? Date.parse(b.scheduledAt) : Number.POSITIVE_INFINITY;
      return aAt - bAt;
    });
  }

  /** @deprecated Prefer listLobbySpaces — kept name for call-site clarity during transition. */
  async listActiveSpaces(viewerUserId?: string | null): Promise<SpaceDto[]> {
    return this.listLobbySpaces(viewerUserId);
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

    return {
      id: space.id,
      title: space.title,
      description: space.description,
      isActive: space.isActive,
      scheduledAt: space.scheduledAt ? space.scheduledAt.toISOString() : null,
      mode: space.mode,
      watchPartyUrl: space.watchPartyUrl,
      radioStreamUrl: space.radioStreamUrl,
      owner,
      listenerCount,
      viewerSubscribed,
      subscriberCount: space._count?.scheduleSubscribers ?? 0,
    };
  }
}
