import { Injectable } from '@nestjs/common';
import { JobsService } from '../jobs/jobs.service';
import { LinkMetadataService } from '../link-metadata/link-metadata.service';
import { PosthogService } from '../../common/posthog/posthog.service';
import { PrismaService } from '../prisma/prisma.service';
import { SideEffectsService } from '../side-effects/side-effects.service';
import { SpacesPresenceService } from './spaces-presence.service';
import { SpacesViewService } from './spaces-view.service';
import {
  NotFoundException,
  ForbiddenException,
  BadRequestException,
} from "@nestjs/common";
import type { SpaceDto } from "../../common/dto";
import { etLocalToUtcMs } from "../../common/time/eastern-day-key";
import { JOBS } from "../jobs/jobs.constants";
import { compareLobbySpaces } from "./spaces-lobby-sort";
import { resolveSpaceEventTitle } from "./spaces-event-title";
import { resolveSpacePlaybackTitle } from "./spaces-playback-title";
import { fetchYouTubeOEmbedTitle } from "./youtube-oembed-title";

export function soonReminderJobId(
  spaceId: string,
  scheduledAtMs: number,
): string {
  return `space-reminder-soon-${spaceId}-${scheduledAtMs}`;
}

export function dayReminderJobId(
  spaceId: string,
  scheduledAtMs: number,
): string {
  return `space-reminder-day-${spaceId}-${scheduledAtMs}`;
}

export const SPACE_SOON_REMINDER_MS = 30 * 60 * 1000;

@Injectable()
export class SpacesScheduleService {
  constructor(
    private readonly view: SpacesViewService,
    private readonly jobs: JobsService,
    private readonly linkMetadata: LinkMetadataService,
    private readonly posthog: PosthogService,
    private readonly prisma: PrismaService,
    private readonly sideEffects: SideEffectsService,
    private readonly spacesPresence: SpacesPresenceService,
  ) {}

  async setSchedule(id: string,
    userId: string,
    scheduledAtRaw: string,
  ): Promise<SpaceDto> {
    const space = await this.prisma.space.findUnique({
      where: { id },
      select: { ownerId: true, scheduledAt: true },
    });
    if (!space) throw new NotFoundException();
    if (space.ownerId !== userId) throw new ForbiddenException();

    const scheduledAt = new Date(scheduledAtRaw);
    if (Number.isNaN(scheduledAt.getTime())) {
      throw new BadRequestException("Invalid schedule time.");
    }
    if (scheduledAt.getTime() <= Date.now() + 60_000) {
      throw new BadRequestException(
        "Schedule time must be at least one minute in the future.",
      );
    }

    const previousMs = space.scheduledAt?.getTime() ?? null;
    const updated = await this.prisma.space.update({
      where: { id },
      data: { scheduledAt },
      include: { owner: true, _count: { select: { scheduleSubscribers: true } } },
    });

    // Host gets the ~30 min heads-up (not day-of / live — see side-effects handler).
    await this.view.ensureOwnerScheduleSubscription(id, userId);

    if (previousMs != null) {
      await this.cancelReminderJobs(id, previousMs);
    }
    await this.enqueueReminderJobs(id, scheduledAt);

    if (previousMs != null && previousMs !== scheduledAt.getTime()) {
      this.sideEffects.dispatch("space.schedule.rescheduled", {
        spaceId: id,
        scheduledAt: scheduledAt.toISOString(),
      });
    } else if (previousMs == null) {
      this.sideEffects.dispatch("space.schedule.announced", { spaceId: id });
    }

    const dto = await this.view.toDto(updated, {
      viewerUserId: userId,
      viewerSubscribedOverride: true,
      subscriberCountOverride: await this.view.countNonOwnerSubscribers(id, userId),
    });
    this.view.emitSpaceUpdated(id, "schedule_set", {
      scheduledAt: dto.scheduledAt,
      isActive: dto.isActive,
      subscriberCount: dto.subscriberCount,
    });
    this.posthog.capture(userId, "space_schedule_set", {
      space_id: id,
      scheduled_at: dto.scheduledAt,
      is_reschedule: previousMs != null,
    });
    return dto;
  }

  async clearSchedule(id: string,
    userId: string,
  ): Promise<SpaceDto> {
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
      return this.view.getSpaceById(id, userId);
    }

    const previousMs = space.scheduledAt.getTime();
    const updated = await this.prisma.space.update({
      where: { id },
      data: { scheduledAt: null },
      include: { owner: true, _count: { select: { scheduleSubscribers: true } } },
    });

    await this.cancelReminderJobs(id, previousMs);
    this.sideEffects.dispatch("space.schedule.cancelled", {
      spaceId: id,
      ownerUserId: space.ownerId,
      spaceTitle: resolveSpaceEventTitle({ title: space.title }),
      ownerUsername: space.owner.username,
    });
    await this.view.clearNonOwnerSubscribers(id, userId);

    const dto = await this.view.toDto(updated, {
      viewerUserId: userId,
      subscriberCountOverride: await this.view.countNonOwnerSubscribers(id, userId),
    });
    this.view.emitSpaceUpdated(id, "schedule_cleared", {
      scheduledAt: null,
      subscriberCount: dto.subscriberCount,
    });
    this.posthog.capture(userId, "space_schedule_cleared", { space_id: id });
    return dto;
  }

  async subscribeToSchedule(id: string,
    userId: string,
  ): Promise<SpaceDto> {
    const space = await this.prisma.space.findUnique({
      where: { id },
      select: { id: true, ownerId: true, scheduledAt: true },
    });
    if (!space) throw new NotFoundException();
    if (!space.scheduledAt || space.scheduledAt.getTime() <= Date.now()) {
      throw new BadRequestException("This space has no upcoming schedule.");
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

    const dto = await this.view.getSpaceById(id, userId);
    this.view.emitSpaceUpdated(id, "schedule_subscribe", {
      subscriberCount: dto.subscriberCount,
    });
    if (!existing && space.ownerId !== userId) {
      this.posthog.capture(userId, "space_schedule_subscribed", { space_id: id });
    }
    return dto;
  }

  async enqueueReminderJobs(spaceId: string,
    scheduledAt: Date,
  ): Promise<void> {
    const scheduledAtMs = scheduledAt.getTime();
    const now = Date.now();
    const soonAt = scheduledAtMs - SPACE_SOON_REMINDER_MS;
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

  async getScheduleSnapshot(spaceId: string,
  ): Promise<{
    scheduledAt: Date | null;
    title: string | null;
    eventTitle: string;
    playbackTitle: string | null;
    watchPartyUrl: string | null;
    ownerUserId: string;
    ownerUsername: string | null;
  } | null> {
    const space = await this.prisma.space.findUnique({
      where: { id: spaceId },
      select: {
        scheduledAt: true,
        title: true,
        mode: true,
        watchPartyUrl: true,
        radioStreamUrl: true,
        ownerId: true,
        owner: { select: { username: true } },
      },
    });
    if (!space) return null;
    const playbackTitle = await resolveSpacePlaybackTitle({
      mode: space.mode,
      watchPartyUrl: space.watchPartyUrl,
      radioStreamUrl: space.radioStreamUrl,
      getLinkTitle: async (url) => {
        const youtubeTitle = await fetchYouTubeOEmbedTitle(url);
        if (youtubeTitle) return youtubeTitle;
        const meta = await this.linkMetadata.getMetadata(url);
        return meta?.title?.trim() || null;
      },
    });
    return {
      scheduledAt: space.scheduledAt,
      title: space.title,
      eventTitle: resolveSpaceEventTitle({ title: space.title, playbackTitle }),
      playbackTitle,
      watchPartyUrl: space.watchPartyUrl,
      ownerUserId: space.ownerId,
      ownerUsername: space.owner.username,
    };
  }

  async listLobbySpaces(viewerUserId?: string | null,
  ): Promise<SpaceDto[]> {
    const now = new Date();
    const viewerId = String(viewerUserId ?? "").trim() || null;
    const counts = this.spacesPresence.getLobbyCountsBySpaceId();
    const occupiedIds = Object.entries(counts)
      .filter(([, n]) => Number(n) > 0)
      .map(([id]) => id);
    const or: Array<
      | { isActive: true }
      | { scheduledAt: { gt: Date } }
      | { ownerId: string }
      | { id: { in: string[] } }
    > = [{ isActive: true }, { scheduledAt: { gt: now } }];
    if (viewerId) or.push({ ownerId: viewerId });
    if (occupiedIds.length > 0) or.push({ id: { in: occupiedIds } });

    const spaces = await this.prisma.space.findMany({
      where: { OR: or },
      include: { owner: true, _count: { select: { scheduleSubscribers: true } } },
      orderBy: { createdAt: "desc" },
    });

    // Backfill host auto-subscribe for any upcoming schedule (covers spaces scheduled
    // before host reminders were automatic).
    const upcoming = spaces.filter(
      (s) => s.scheduledAt != null && s.scheduledAt.getTime() > now.getTime(),
    );
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
      nonOwnerCountBySpaceId.set(
        row.spaceId,
        (nonOwnerCountBySpaceId.get(row.spaceId) ?? 0) + 1,
      );
    }

    const followingOwnerIds = new Set(followRows.map((r) => r.followingId));

    const dtos = await Promise.all(
      spaces.map((s) =>
        this.view.toDto(s, {
          viewerUserId: viewerId,
          listenerCountOverride: counts[s.id],
          viewerSubscribedOverride: subscribedIds.has(s.id),
          subscriberCountOverride: nonOwnerCountBySpaceId.get(s.id) ?? 0,
          viewerFollowsOwnerOverride: Boolean(
            viewerId &&
            s.ownerId !== viewerId &&
            followingOwnerIds.has(s.ownerId),
          ),
        }),
      ),
    );

    return dtos.sort((a, b) =>
      compareLobbySpaces(a, b, { viewerId, followingOwnerIds }),
    );
  }

  async cancelReminderJobs(spaceId: string, scheduledAtMs: number): Promise<void> {
    await this.jobs.removeById(JOBS.spaceReminderDay, dayReminderJobId(spaceId, scheduledAtMs));
    await this.jobs.removeById(JOBS.spaceReminderSoon, soonReminderJobId(spaceId, scheduledAtMs));
  }
}






