import { Injectable, Logger, Optional } from "@nestjs/common";
import { MutesService } from "../mutes/mutes.service";
import { Prisma, type NotificationKind } from "@prisma/client";
import { PrismaService } from "../prisma/prisma.service";
import { PresenceRealtimeService } from "../presence/presence-realtime.service";
import { JobsService } from "../jobs/jobs.service";
import { SideEffectsService } from "../side-effects/side-effects.service";
import { NotificationQueryService } from "./notification-query.service";
import { NotificationReadStateService } from "./notification-read-state.service";
import { CacheInvalidationService } from "../redis/cache-invalidation.service";
import { PostsReadService } from "../posts-read/posts-read.service";
import { NotificationWriterSupportService } from "./notification-writer-support.service";

@Injectable()
export class NotificationWriterCommunityService {
  readonly logger = new Logger(NotificationWriterCommunityService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly postsRead: PostsReadService,
    private readonly presenceRealtime: PresenceRealtimeService,
    private readonly jobs: JobsService,
    private readonly sideEffects: SideEffectsService,
    private readonly query: NotificationQueryService,
    private readonly readState: NotificationReadStateService,
    private readonly support: NotificationWriterSupportService,
    private readonly cacheInvalidation?: CacheInvalidationService,
    @Optional() private readonly mutes?: MutesService,
  ) {}
  // ─────────────────────────────────────────────────────────────────────────
  // Group lifecycle notification upserts
  // ─────────────────────────────────────────────────────────────────────────

  /**
   * Shared upsert core: find-or-create a notification row identified by
   * (recipient, kind, actorUser, subjectGroup). On re-trigger with the
   * same key, bumps `createdAt`, clears delivered/read timestamps, and
   * increments the undelivered counter if the row was previously delivered.
   */
  private async upsertGroupNotification(params: {
    recipientUserId: string;
    kind: NotificationKind;
    actorUserId: string | null;
    subjectGroupId: string;
    title: string;
  }): Promise<{
    notificationId: string;
    undeliveredCount: number;
    isNew: boolean;
  }> {
    const { recipientUserId, kind, actorUserId, subjectGroupId, title } =
      params;
    // Resolve presence before the transaction so the Redis call doesn't extend it.
    const presentAt = await this.support.presentAtForRecipient(recipientUserId);
    return this.prisma.$transaction(
      async (tx) => {
        const existing = await tx.notification.findFirst({
          where: {
            recipientUserId,
            kind,
            actorUserId: actorUserId ?? undefined,
            subjectGroupId,
          },
          select: { id: true, deliveredAt: true },
        });

        if (existing) {
          const wasDelivered = existing.deliveredAt != null;
          await tx.notification.update({
            where: { id: existing.id },
            data: {
              createdAt: new Date(),
              deliveredAt: null,
              readAt: null,
              ignoredAt: null,
              title,
              presentAt: presentAt ?? null,
            },
          });
          if (wasDelivered) {
            await tx.user.update({
              where: { id: recipientUserId },
              data: { undeliveredNotificationCount: { increment: 1 } },
            });
          }
          const undeliveredCount = await tx.notification.count({
            where: this.readState.undeliveredBellWhere(recipientUserId),
          });
          return {
            notificationId: existing.id,
            undeliveredCount,
            isNew: false,
          };
        }

        const created = await tx.notification.create({
          data: {
            recipientUserId,
            kind,
            actorUserId: actorUserId ?? undefined,
            subjectGroupId,
            title,
            presentAt: presentAt ?? undefined,
          },
          select: { id: true },
        });
        await tx.user.update({
          where: { id: recipientUserId },
          data: { undeliveredNotificationCount: { increment: 1 } },
        });
        const undeliveredCount = await tx.notification.count({
          where: this.readState.undeliveredBellWhere(recipientUserId),
        });
        return { notificationId: created.id, undeliveredCount, isNew: true };
      },
      { isolationLevel: Prisma.TransactionIsolationLevel.Serializable },
    );
  }

  private async emitGroupNotification(
    recipientUserId: string,
    notificationId: string,
    undeliveredCount: number,
  ) {
    this.support.emitBellAndInvalidateList(recipientUserId, { undeliveredCount });
    try {
      const dto = await this.query.buildNotificationDtoForRecipient({
        recipientUserId,
        notificationId,
      });
      if (dto)
        this.presenceRealtime.emitNotificationNew(recipientUserId, {
          notification: dto,
        });
    } catch {
      /* best-effort */
    }
  }

  private async pushGroupNotification(params: {
    recipientUserId: string;
    actorUserId: string | null;
    kind: NotificationKind;
    subjectGroupId: string;
    notificationId: string;
  }): Promise<void> {
    const {
      recipientUserId,
      actorUserId,
      kind,
      subjectGroupId,
      notificationId,
    } = params;
    this.sideEffects.dispatch("notification.push", {
      recipientUserId,
      kind,
      actorUserId,
      fallbackTitle: null,
      body: null,
      subjectPostId: null,
      subjectUserId: null,
      subjectGroupId,
      notificationId,
    });
  }

  /**
   * Notify a single existing member that a new user joined their group.
   * Per-(recipient, actor, group) row so multi-join events roll up in the feed.
   */
  async upsertGroupMemberJoinedNotification(params: {
    recipientUserId: string;
    joinerUserId: string;
    groupId: string;
  }): Promise<void> {
    const { recipientUserId, joinerUserId, groupId } = params;
    if (recipientUserId === joinerUserId) return;
    const result = await this.upsertGroupNotification({
      recipientUserId,
      kind: "community_group_member_joined",
      actorUserId: joinerUserId,
      subjectGroupId: groupId,
      title: "joined the group",
    });
    await this.emitGroupNotification(
      recipientUserId,
      result.notificationId,
      result.undeliveredCount,
    );
    if (result.isNew) {
      void this.pushGroupNotification({
        recipientUserId,
        actorUserId: joinerUserId,
        kind: "community_group_member_joined",
        subjectGroupId: groupId,
        notificationId: result.notificationId,
      });
    }
  }

  /**
   * Notify the requester that their join request was approved or rejected.
   */
  async upsertGroupJoinDecisionNotification(params: {
    recipientUserId: string;
    groupId: string;
    actorUserId: string;
    decision: "approved" | "rejected";
  }): Promise<void> {
    const { recipientUserId, groupId, actorUserId, decision } = params;
    if (recipientUserId === actorUserId) return;
    const kind: NotificationKind =
      decision === "approved"
        ? "community_group_join_approved"
        : "community_group_join_rejected";
    const title =
      decision === "approved"
        ? "Your join request was approved"
        : "Your join request was not accepted";
    const result = await this.upsertGroupNotification({
      recipientUserId,
      kind,
      actorUserId,
      subjectGroupId: groupId,
      title,
    });
    await this.emitGroupNotification(
      recipientUserId,
      result.notificationId,
      result.undeliveredCount,
    );
    if (result.isNew) {
      void this.pushGroupNotification({
        recipientUserId,
        actorUserId,
        kind,
        subjectGroupId: groupId,
        notificationId: result.notificationId,
      });
    }
  }

  /**
   * Notify a user that they were removed from a group.
   */
  async upsertGroupMemberRemovedNotification(params: {
    recipientUserId: string;
    groupId: string;
    actorUserId: string;
  }): Promise<void> {
    const { recipientUserId, groupId, actorUserId } = params;
    if (recipientUserId === actorUserId) return;
    const result = await this.upsertGroupNotification({
      recipientUserId,
      kind: "community_group_member_removed",
      actorUserId,
      subjectGroupId: groupId,
      title: "You were removed from a group",
    });
    await this.emitGroupNotification(
      recipientUserId,
      result.notificationId,
      result.undeliveredCount,
    );
    if (result.isNew) {
      void this.pushGroupNotification({
        recipientUserId,
        actorUserId,
        kind: "community_group_member_removed",
        subjectGroupId: groupId,
        notificationId: result.notificationId,
      });
    }
  }

  /**
   * Notify a member that a group they were in was disbanded.
   */
  async upsertGroupDisbandedNotification(params: {
    recipientUserId: string;
    groupId: string;
    actorUserId: string;
  }): Promise<void> {
    const { recipientUserId, groupId, actorUserId } = params;
    if (recipientUserId === actorUserId) return;
    const result = await this.upsertGroupNotification({
      recipientUserId,
      kind: "community_group_disbanded",
      actorUserId,
      subjectGroupId: groupId,
      title: "A group you were in was disbanded",
    });
    await this.emitGroupNotification(
      recipientUserId,
      result.notificationId,
      result.undeliveredCount,
    );
    if (result.isNew) {
      void this.pushGroupNotification({
        recipientUserId,
        actorUserId,
        kind: "community_group_disbanded",
        subjectGroupId: groupId,
        notificationId: result.notificationId,
      });
    }
  }

  // ─────────────────────────────────────────────────────────────────────────
  // Crew lifecycle notification upserts (filling in unused enum values)
  // ─────────────────────────────────────────────────────────────────────────

  /**
   * Shared upsert for crew-scoped notifications.
   */
  private async upsertCrewNotification(params: {
    recipientUserId: string;
    kind: NotificationKind;
    actorUserId: string | null;
    subjectCrewId: string;
    title: string;
  }): Promise<{
    notificationId: string;
    undeliveredCount: number;
    isNew: boolean;
  }> {
    const { recipientUserId, kind, actorUserId, subjectCrewId, title } = params;
    // Resolve presence before the transaction so the Redis call doesn't extend it.
    const presentAt = await this.support.presentAtForRecipient(recipientUserId);
    return this.prisma.$transaction(
      async (tx) => {
        const existing = await tx.notification.findFirst({
          where: {
            recipientUserId,
            kind,
            actorUserId: actorUserId ?? undefined,
            subjectCrewId,
          },
          select: { id: true, deliveredAt: true },
        });

        if (existing) {
          const wasDelivered = existing.deliveredAt != null;
          await tx.notification.update({
            where: { id: existing.id },
            data: {
              createdAt: new Date(),
              deliveredAt: null,
              readAt: null,
              ignoredAt: null,
              title,
              presentAt: presentAt ?? null,
            },
          });
          if (wasDelivered) {
            await tx.user.update({
              where: { id: recipientUserId },
              data: { undeliveredNotificationCount: { increment: 1 } },
            });
          }
          const undeliveredCount = await tx.notification.count({
            where: this.readState.undeliveredBellWhere(recipientUserId),
          });
          return {
            notificationId: existing.id,
            undeliveredCount,
            isNew: false,
          };
        }

        const created = await tx.notification.create({
          data: {
            recipientUserId,
            kind,
            actorUserId: actorUserId ?? undefined,
            subjectCrewId,
            title,
            presentAt: presentAt ?? undefined,
          },
          select: { id: true },
        });
        await tx.user.update({
          where: { id: recipientUserId },
          data: { undeliveredNotificationCount: { increment: 1 } },
        });
        const undeliveredCount = await tx.notification.count({
          where: this.readState.undeliveredBellWhere(recipientUserId),
        });
        return { notificationId: created.id, undeliveredCount, isNew: true };
      },
      { isolationLevel: Prisma.TransactionIsolationLevel.Serializable },
    );
  }

  private async emitCrewNotification(
    recipientUserId: string,
    notificationId: string,
    undeliveredCount: number,
  ) {
    this.support.emitBellAndInvalidateList(recipientUserId, { undeliveredCount });
    try {
      const dto = await this.query.buildNotificationDtoForRecipient({
        recipientUserId,
        notificationId,
      });
      if (dto)
        this.presenceRealtime.emitNotificationNew(recipientUserId, {
          notification: dto,
        });
    } catch {
      /* best-effort */
    }
  }

  /** Notify remaining crew members that someone left. */
  async upsertCrewMemberLeftNotification(params: {
    recipientUserId: string;
    leaverUserId: string;
    crewId: string;
  }): Promise<void> {
    const { recipientUserId, leaverUserId, crewId } = params;
    if (recipientUserId === leaverUserId) return;
    const result = await this.upsertCrewNotification({
      recipientUserId,
      kind: "crew_member_left",
      actorUserId: leaverUserId,
      subjectCrewId: crewId,
      title: "left your crew",
    });
    await this.emitCrewNotification(
      recipientUserId,
      result.notificationId,
      result.undeliveredCount,
    );
  }

  /** Notify the kicked member that they were removed. */
  async upsertCrewMemberKickedNotification(params: {
    recipientUserId: string;
    actorUserId: string;
    crewId: string;
  }): Promise<void> {
    const { recipientUserId, actorUserId, crewId } = params;
    if (recipientUserId === actorUserId) return;
    const result = await this.upsertCrewNotification({
      recipientUserId,
      kind: "crew_member_kicked",
      actorUserId,
      subjectCrewId: crewId,
      title: "You were removed from your crew",
    });
    await this.emitCrewNotification(
      recipientUserId,
      result.notificationId,
      result.undeliveredCount,
    );
  }

  /** Notify every former crew member that the crew was disbanded. */
  async upsertCrewDisbandedNotification(params: {
    recipientUserId: string;
    actorUserId: string;
    crewId: string;
  }): Promise<void> {
    const { recipientUserId, actorUserId, crewId } = params;
    if (recipientUserId === actorUserId) return;
    const result = await this.upsertCrewNotification({
      recipientUserId,
      kind: "crew_disbanded",
      actorUserId,
      subjectCrewId: crewId,
      title: "Your crew was disbanded",
    });
    await this.emitCrewNotification(
      recipientUserId,
      result.notificationId,
      result.undeliveredCount,
    );
  }
}
