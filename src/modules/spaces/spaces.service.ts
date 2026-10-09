import { NotificationWriterFanoutService } from "../notifications";
import {
  Injectable,
  NotFoundException,
  ForbiddenException,
  ConflictException,
  BadRequestException,
  Inject,
} from "@nestjs/common";
import type { SpaceMode } from "@prisma/client";
import type { SpaceDto, SpaceReactionDto } from "../../common/dto";
import {
  ALLOWED_REACTIONS,
  findReactionById,
} from "../../common/constants/reactions";
import {
  easternDayKey,
  etLocalToUtcMs,
} from "../../common/time/eastern-day-key";
import { PrismaService } from "../prisma/prisma.service";
import { SideEffectsService } from "../side-effects/side-effects.service";
import { FANOUT_CONCURRENCY, runInBatches } from "../side-effects/batch";
import { PosthogService } from "../../common/posthog/posthog.service";
import { resolveSpaceEventTitle } from "./spaces-event-title";
import {
  SPACE_SOON_REMINDER_MS,
  SpacesScheduleService,
} from "./spaces-schedule.service";
import { SpacesViewService } from "./spaces-view.service";

@Injectable()
export class SpacesService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly sideEffects: SideEffectsService,
    @Inject(NotificationWriterFanoutService)
    private readonly notifications: Pick<
      NotificationWriterFanoutService,
      "upsertSpaceScheduleNotification" | "listRecipientIdsForSpaceNotification"
    >,
    private readonly posthog: PosthogService,
    private readonly view: SpacesViewService,
    private readonly schedule: SpacesScheduleService,
  ) {}

  async getSpaceById(
    id: string,
    viewerUserId?: string | null,
  ): Promise<SpaceDto> {
    return this.view.getSpaceById(id, viewerUserId);
  }

  async createSpace(
    userId: string,
    data: { title: string; description?: string | null },
  ): Promise<SpaceDto> {
    const existing = await this.prisma.space.findUnique({
      where: { ownerId: userId },
    });
    if (existing) throw new ConflictException("You already have a space.");

    const space = await this.prisma.space.create({
      data: {
        ownerId: userId,
        title: data.title,
        description: data.description ?? null,
      },
      include: {
        owner: true,
        _count: { select: { scheduleSubscribers: true } },
      },
    });

    const dto = await this.view.toDto(space, { viewerUserId: userId });
    this.posthog.capture(userId, "space_created", { space_id: space.id });
    return dto;
  }

  async getSpaceByOwnerUsername(
    username: string,
    viewerUserId?: string | null,
  ): Promise<SpaceDto> {
    const user = await this.prisma.user.findFirst({
      where: { username: { equals: username, mode: "insensitive" } },
      select: { id: true },
    });
    if (!user) throw new NotFoundException();

    const space = await this.prisma.space.findUnique({
      where: { ownerId: user.id },
      include: {
        owner: true,
        _count: { select: { scheduleSubscribers: true } },
      },
    });
    if (!space) throw new NotFoundException();
    await this.view.ensureOwnerSubscribedIfScheduled(space);
    return this.view.toDto(space, {
      viewerUserId,
      subscriberCountOverride: await this.view.countNonOwnerSubscribers(
        space.id,
        space.ownerId,
      ),
    });
  }

  async getSpaceByOwnerId(
    ownerId: string,
    viewerUserId?: string | null,
  ): Promise<SpaceDto | null> {
    const space = await this.prisma.space.findUnique({
      where: { ownerId },
      include: {
        owner: true,
        _count: { select: { scheduleSubscribers: true } },
      },
    });
    if (!space) return null;
    await this.view.ensureOwnerSubscribedIfScheduled(space);
    return this.view.toDto(space, {
      viewerUserId,
      subscriberCountOverride: await this.view.countNonOwnerSubscribers(
        space.id,
        space.ownerId,
      ),
    });
  }

  async getOwnerIdForSpace(spaceId: string): Promise<string | null> {
    const space = await this.prisma.space.findUnique({
      where: { id: spaceId },
      select: { ownerId: true },
    });
    return space?.ownerId ?? null;
  }

  async updateSpace(
    id: string,
    userId: string,
    data: { title?: string | null; description?: string | null },
  ): Promise<SpaceDto> {
    const space = await this.prisma.space.findUnique({
      where: { id },
      select: { ownerId: true },
    });
    if (!space) throw new NotFoundException();
    if (space.ownerId !== userId) throw new ForbiddenException();

    const updated = await this.prisma.space.update({
      where: { id },
      data: {
        ...(data.title !== undefined ? { title: data.title } : {}),
        ...(data.description !== undefined
          ? { description: data.description }
          : {}),
      },
      include: {
        owner: true,
        _count: { select: { scheduleSubscribers: true } },
      },
    });

    const dto = await this.view.toDto(updated, { viewerUserId: userId });
    this.view.emitSpaceUpdated(id, "updated", {
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
      const recipientUserIds = await this.listAudienceUserIds(
        id,
        space.ownerId,
      );
      await this.schedule.cancelReminderJobs(id, space.scheduledAt.getTime());
      const title = `${resolveSpaceEventTitle({ title: space.title })} cancelled`;
      const body = "The scheduled space was cancelled.";
      await runInBatches(
        recipientUserIds,
        FANOUT_CONCURRENCY,
        async (recipientUserId) => {
          await this.notifications.upsertSpaceScheduleNotification({
            recipientUserId,
            kind: "space_schedule_cancelled",
            spaceId: id,
            actorUserId: space.ownerId,
            title,
            body,
          });
        },
      );
      this.sideEffects.dispatch("space.schedule.cancelled", {
        spaceId: id,
        scheduledAt: space.scheduledAt.toISOString(),
        ownerUserId: space.ownerId,
        spaceTitle: resolveSpaceEventTitle({ title: space.title }),
        ownerUsername: space.owner.username,
        recipientUserIds,
      });
    }

    // Quiet "was live" retitle must land while the Space row still exists —
    // deleting SET NULLs subjectSpaceId, so an async ended job would miss the rows.
    const liveRecipientIds =
      await this.notifications.listRecipientIdsForSpaceNotification({
        spaceId: id,
        kind: "space_live",
      });
    if (liveRecipientIds.length > 0) {
      const title = `${resolveSpaceEventTitle({ title: space.title })} was live`;
      const body = "It's no longer live.";
      await runInBatches(
        liveRecipientIds,
        FANOUT_CONCURRENCY,
        async (recipientUserId) => {
          await this.notifications.upsertSpaceScheduleNotification({
            recipientUserId,
            kind: "space_live",
            spaceId: id,
            actorUserId: space.ownerId,
            title,
            body,
            resurface: false,
          });
        },
      );
    }

    await this.prisma.space.delete({ where: { id } });
    this.view.emitSpaceUpdated(id, "deleted", { deleted: true });
    this.posthog.capture(userId, "space_deleted", { space_id: id });
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
      include: {
        owner: true,
        _count: { select: { scheduleSubscribers: true } },
      },
    });

    if (previousScheduledAt) {
      await this.schedule.cancelReminderJobs(id, previousScheduledAt.getTime());
    }
    // Snapshot before clearing Notify-me rows. Scheduled go-live (including early)
    // uses followers ∪ subscribers — same audience as the 30-min reminder — so
    // people who heard about the time also hear that it started. Unscheduled
    // go-live is followers only. The handler also unions existing space_live rows.
    const recipientUserIds = previousScheduledAt
      ? await this.listAudienceUserIds(id, userId)
      : (await this.listFollowerUserIds(userId)).filter(
          (uid) => uid !== userId,
        );
    this.sideEffects.dispatch("space.schedule.live", {
      spaceId: id,
      recipientUserIds,
    });
    await this.view.clearNonOwnerSubscribers(id, userId);

    const dto = await this.view.toDto(updated, {
      viewerUserId: userId,
      subscriberCountOverride: await this.view.countNonOwnerSubscribers(
        id,
        userId,
      ),
    });
    this.view.emitSpaceUpdated(id, "activated", {
      isActive: true,
      scheduledAt: null,
      subscriberCount: dto.subscriberCount,
      playbackTitle: dto.playbackTitle,
    });
    this.posthog.capture(userId, "space_activated", {
      space_id: id,
      mode: dto.mode,
      had_schedule: Boolean(previousScheduledAt),
    });
    return dto;
  }

  async deactivateSpace(id: string, userId: string): Promise<SpaceDto> {
    const space = await this.prisma.space.findUnique({
      where: { id },
      select: { ownerId: true },
    });
    if (!space) throw new NotFoundException();
    if (space.ownerId !== userId) throw new ForbiddenException();

    const updated = await this.prisma.space.update({
      where: { id },
      data: { isActive: false },
      include: {
        owner: true,
        _count: { select: { scheduleSubscribers: true } },
      },
    });
    const dto = await this.view.toDto(updated, { viewerUserId: userId });
    this.view.emitSpaceUpdated(id, "deactivated", { isActive: false });
    this.sideEffects.dispatch("space.schedule.ended", { spaceId: id });
    this.posthog.capture(userId, "space_deactivated", {
      space_id: id,
      mode: dto.mode,
      reason: "owner",
    });
    return dto;
  }

  /**
   * System path: flip an abandoned live space offline (owner left / empty lobby sweep).
   * Returns true when a row was updated.
   */
  async deactivateIfActive(spaceId: string): Promise<boolean> {
    const id = String(spaceId ?? "").trim();
    if (!id) return false;
    const result = await this.prisma.space.updateMany({
      where: { id, isActive: true },
      data: { isActive: false },
    });
    if (result.count > 0) {
      this.view.emitSpaceUpdated(id, "deactivated", { isActive: false });
      this.sideEffects.dispatch("space.schedule.ended", { spaceId: id });
      const row = await this.prisma.space.findUnique({
        where: { id },
        select: { ownerId: true, mode: true },
      });
      if (row) {
        this.posthog.capture(row.ownerId, "space_deactivated", {
          space_id: id,
          mode: row.mode,
          reason: "idle",
        });
      }
    }
    return result.count > 0;
  }

  async setMode(
    id: string,
    userId: string,
    data: {
      mode: SpaceMode;
      watchPartyUrl?: string | null;
      radioStreamUrl?: string | null;
    },
  ): Promise<SpaceDto> {
    const space = await this.prisma.space.findUnique({
      where: { id },
      select: { ownerId: true, mode: true },
    });
    if (!space) throw new NotFoundException();
    if (space.ownerId !== userId) throw new ForbiddenException();

    if (data.mode === "RADIO" && !data.radioStreamUrl?.trim()) {
      throw new BadRequestException("A stream URL is required for radio mode.");
    }

    const updated = await this.prisma.space.update({
      where: { id },
      data: {
        mode: data.mode,
        watchPartyUrl:
          data.mode === "WATCH_PARTY"
            ? data.watchPartyUrl?.trim() || null
            : null,
        radioStreamUrl:
          data.mode === "RADIO" ? (data.radioStreamUrl?.trim() ?? null) : null,
      },
      include: {
        owner: true,
        _count: { select: { scheduleSubscribers: true } },
      },
    });
    const dto = await this.view.toDto(updated, { viewerUserId: userId });
    this.view.emitSpaceUpdated(id, "mode_changed", {
      mode: dto.mode,
      watchPartyUrl: dto.watchPartyUrl,
      radioStreamUrl: dto.radioStreamUrl,
      playbackTitle: dto.playbackTitle,
    });
    this.posthog.capture(userId, "space_mode_set", {
      space_id: id,
      mode: dto.mode,
      from_mode: space.mode,
      has_watch_party_url: Boolean(dto.watchPartyUrl),
      has_radio_url: Boolean(dto.radioStreamUrl),
    });
    return dto;
  }

  async setSchedule(
    id: string,
    userId: string,
    scheduledAtRaw: string,
  ): Promise<SpaceDto> {
    return this.schedule.setSchedule(id, userId, scheduledAtRaw);
  }

  async clearSchedule(id: string, userId: string): Promise<SpaceDto> {
    return this.schedule.clearSchedule(id, userId);
  }

  async subscribeToSchedule(id: string, userId: string): Promise<SpaceDto> {
    return this.schedule.subscribeToSchedule(id, userId);
  }

  async unsubscribeFromSchedule(id: string, userId: string): Promise<SpaceDto> {
    const space = await this.prisma.space.findUnique({
      where: { id },
      select: { id: true, ownerId: true },
    });
    if (!space) throw new NotFoundException();
    if (space.ownerId === userId) {
      throw new BadRequestException(
        "Host reminders stay on for your scheduled space.",
      );
    }

    const removed = await this.prisma.spaceScheduleSubscriber.deleteMany({
      where: { spaceId: id, userId },
    });

    const dto = await this.view.getSpaceById(id, userId);
    this.view.emitSpaceUpdated(id, "schedule_unsubscribe", {
      subscriberCount: dto.subscriberCount,
    });
    if (removed.count > 0) {
      this.posthog.capture(userId, "space_schedule_unsubscribed", {
        space_id: id,
      });
    }
    return dto;
  }

  async listLobbySpaces(viewerUserId?: string | null): Promise<SpaceDto[]> {
    return this.schedule.listLobbySpaces(viewerUserId);
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
    return findReactionById(String(reactionIdRaw ?? ""));
  }

  async enqueueReminderJobs(spaceId: string, scheduledAt: Date): Promise<void> {
    return this.schedule.enqueueReminderJobs(spaceId, scheduledAt);
  }

  async getScheduleSnapshot(spaceId: string): Promise<{
    scheduledAt: Date | null;
    title: string | null;
    eventTitle: string;
    playbackTitle: string | null;
    watchPartyUrl: string | null;
    ownerUserId: string;
    ownerUsername: string | null;
  } | null> {
    return this.schedule.getScheduleSnapshot(spaceId);
  }

  async listSubscriberUserIds(spaceId: string): Promise<string[]> {
    const rows = await this.prisma.spaceScheduleSubscriber.findMany({
      where: { spaceId },
      select: { userId: true },
    });
    return rows.map((r) => r.userId);
  }

  async listFollowerUserIds(ownerUserId: string): Promise<string[]> {
    const [follows, operators] = await Promise.all([
      this.prisma.follow.findMany({
        where: { followingId: ownerUserId },
        select: { followerId: true },
      }),
      this.prisma.userPageOperator.findMany({
        where: { pageUserId: ownerUserId },
        select: { operatorUserId: true },
      }),
    ]);
    const skip = new Set(operators.map((row) => row.operatorUserId));
    skip.add(ownerUserId);
    return follows
      .map((row) => row.followerId)
      .filter((id) => id && !skip.has(id));
  }

  /** Followers ∪ Notify-me subscribers, minus the host. */
  async listAudienceUserIds(
    spaceId: string,
    ownerUserId: string,
  ): Promise<string[]> {
    const [followers, subscribers] = await Promise.all([
      this.listFollowerUserIds(ownerUserId),
      this.listSubscriberUserIds(spaceId),
    ]);
    const seen = new Set<string>();
    const out: string[] = [];
    for (const id of [...followers, ...subscribers]) {
      const uid = String(id ?? "").trim();
      if (!uid || uid === ownerUserId || seen.has(uid)) continue;
      seen.add(uid);
      out.push(uid);
    }
    return out;
  }

  /** Day-of reminder still valid for this schedule instant? */
  isDayReminderStillValid(
    scheduledAt: Date,
    scheduledAtMs: number,
    now = Date.now(),
  ): boolean {
    if (scheduledAt.getTime() !== scheduledAtMs) return false;
    if (scheduledAtMs <= now) return false;
    const dayAt = etLocalToUtcMs(scheduledAt, 9, 0);
    const soonAt = scheduledAtMs - SPACE_SOON_REMINDER_MS;
    // Fire only if we're at/after the day slot conceptually; job already delayed to dayAt.
    // Skip if day slot would have been after the soon window (should not have been enqueued).
    if (dayAt > soonAt) return false;
    // Same ET calendar day as scheduled.
    return (
      easternDayKey(new Date(now)) === easternDayKey(scheduledAt) ||
      now >= dayAt
    );
  }
}
