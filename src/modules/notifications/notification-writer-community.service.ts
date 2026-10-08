import { Injectable, Logger, Optional } from "@nestjs/common";
import { MutesService } from "../mutes/mutes.service";
import { Prisma, type NotificationKind } from "@prisma/client";
import { PrismaService } from "../prisma/prisma.service";
import { PresenceRealtimeService } from "../presence/presence-realtime.service";
import { PresenceRedisStateService } from "../presence/presence-redis-state.service";
import { JobsService } from "../jobs/jobs.service";
import { FANOUT_CONCURRENCY, runInBatches } from "../side-effects/batch";
import { chunk } from '../../common/arrays/chunk';
import { FANOUT_CHUNK_SIZE } from "../side-effects/side-effects.constants";
import { SideEffectsService } from "../side-effects/side-effects.service";
import { NotificationQueryService } from "./notification-query.service";
import {
  NotificationReadStateService,
} from "./notification-read-state.service";
import { CacheInvalidationService } from "../redis/cache-invalidation.service";
import { PostsReadService } from "../posts-read/posts-read.service";
import { NotificationWriterSupportService } from "./notification-writer-support.service";

@Injectable()
export class NotificationWriterCommunityService {
  private readonly logger = new Logger(NotificationWriterCommunityService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly postsRead: PostsReadService,
    private readonly presenceRealtime: PresenceRealtimeService,
    private readonly presenceRedis: PresenceRedisStateService,
    private readonly jobs: JobsService,
    private readonly sideEffects: SideEffectsService,
    private readonly query: NotificationQueryService,
    private readonly readState: NotificationReadStateService,
    private readonly support: NotificationWriterSupportService,
    private readonly cacheInvalidation?: CacheInvalidationService,
    @Optional() private readonly mutes?: MutesService,
  ) {}
  /**
   * Create or refresh a community-group invite notification on the invitee. On
   * re-invite (existing pending invite), bumps `createdAt`, **re-marks unread**
   * (clears delivered/readAt) and bumps the undelivered counter so the bell
   * badge reflects the new ping. Otherwise creates a fresh row.
   *
   * Returns true when the invitee was actively (re)notified — caller should
   * stamp `lastNotifiedAt` on the invite when this returns true.
   */
  async upsertCommunityGroupInviteReceivedNotification(params: {
    inviteeUserId: string;
    inviterUserId: string;
    groupId: string;
    inviteId: string;
    bodySnippet?: string | null;
  }): Promise<{ notified: boolean }> {
    const { inviteeUserId, inviterUserId, groupId, inviteId, bodySnippet } =
      params;
    if (inviteeUserId === inviterUserId) return { notified: false };

    // Resolve presence before the transaction so the Redis call doesn't extend it.
    const presentAt = await this.support.presentAtForRecipient(inviteeUserId);

    const result = await this.prisma.$transaction(async (tx) => {
      const existing = await tx.notification.findFirst({
        where: {
          recipientUserId: inviteeUserId,
          kind: "community_group_invite_received",
          subjectCommunityGroupInviteId: inviteId,
        },
        select: { id: true, deliveredAt: true, readAt: true },
      });

      if (existing) {
        const now = new Date();
        const wasDelivered = existing.deliveredAt != null;
        await tx.notification.update({
          where: { id: existing.id },
          data: {
            createdAt: now,
            deliveredAt: null,
            readAt: null,
            ignoredAt: null,
            actorUserId: inviterUserId,
            body: bodySnippet ?? undefined,
            presentAt: presentAt ?? null,
          },
        });
        if (wasDelivered) {
          await tx.user.update({
            where: { id: inviteeUserId },
            data: { undeliveredNotificationCount: { increment: 1 } },
          });
        }
        const undeliveredCount = await tx.notification.count({
          where: this.readState.undeliveredBellWhere(inviteeUserId),
        });
        return {
          kind: "updated" as const,
          notificationId: existing.id,
          undeliveredCount,
        };
      }

      const created = await tx.notification.create({
        data: {
          recipientUserId: inviteeUserId,
          kind: "community_group_invite_received",
          actorUserId: inviterUserId,
          subjectGroupId: groupId,
          subjectCommunityGroupInviteId: inviteId,
          title: "invited you to their group",
          body: bodySnippet ?? undefined,
          presentAt: presentAt ?? undefined,
        },
        select: { id: true },
      });
      await tx.user.update({
        where: { id: inviteeUserId },
        data: { undeliveredNotificationCount: { increment: 1 } },
      });
      const undeliveredCount = await tx.notification.count({
        where: this.readState.undeliveredBellWhere(inviteeUserId),
      });
      return {
        kind: "created" as const,
        notificationId: created.id,
        undeliveredCount,
      };
    });

    this.support.emitBellAndInvalidateList(inviteeUserId, {
      undeliveredCount: result.undeliveredCount,
    });
    try {
      const dto = await this.query.buildNotificationDtoForRecipient({
        recipientUserId: inviteeUserId,
        notificationId: result.notificationId,
      });
      if (dto) {
        this.presenceRealtime.emitNotificationNew(inviteeUserId, {
          notification: dto,
        });
      }
    } catch (err) {
      this.logger.debug(
        `[notifications] Failed to emit group invite notification: ${err}`,
      );
    }

    // Web push (best-effort, gated on user prefs).
    this.sideEffects.dispatch("notification.push", {
      recipientUserId: inviteeUserId,
      kind: "community_group_invite_received",
      actorUserId: inviterUserId,
      fallbackTitle: "invited you to their group",
      body: bodySnippet ?? null,
      subjectPostId: null,
      subjectUserId: null,
      subjectGroupId: groupId,
      subjectCommunityGroupInviteId: inviteId,
      notificationId: result.notificationId,
    });

    return { notified: true };
  }

  /**
   * Create or refresh a community-group invite *response* notification on the
   * inviter (accepted/declined). On a repeat from the same actor + invite,
   * bumps `createdAt` and re-marks unread instead of stacking duplicate rows.
   */
  async upsertCommunityGroupInviteResponseNotification(params: {
    inviterUserId: string;
    inviteeUserId: string;
    groupId: string;
    inviteId: string;
    response: "accepted" | "declined";
  }): Promise<void> {
    const { inviterUserId, inviteeUserId, groupId, inviteId, response } =
      params;
    if (inviterUserId === inviteeUserId) return;
    const kind: NotificationKind =
      response === "accepted"
        ? "community_group_invite_accepted"
        : "community_group_invite_declined";

    // Resolve presence before the transaction so the Redis call doesn't extend it.
    const presentAt = await this.support.presentAtForRecipient(inviterUserId);

    const result = await this.prisma.$transaction(async (tx) => {
      const existing = await tx.notification.findFirst({
        where: {
          recipientUserId: inviterUserId,
          kind,
          subjectCommunityGroupInviteId: inviteId,
          actorUserId: inviteeUserId,
        },
        select: { id: true, deliveredAt: true },
      });
      if (existing) {
        const now = new Date();
        const wasDelivered = existing.deliveredAt != null;
        await tx.notification.update({
          where: { id: existing.id },
          data: {
            createdAt: now,
            deliveredAt: null,
            readAt: null,
            ignoredAt: null,
            presentAt: presentAt ?? null,
          },
        });
        if (wasDelivered) {
          await tx.user.update({
            where: { id: inviterUserId },
            data: { undeliveredNotificationCount: { increment: 1 } },
          });
        }
        const undeliveredCount = await tx.notification.count({
          where: this.readState.undeliveredBellWhere(inviterUserId),
        });
        return {
          kind: "updated" as const,
          notificationId: existing.id,
          undeliveredCount,
        };
      }
      const created = await tx.notification.create({
        data: {
          recipientUserId: inviterUserId,
          kind,
          actorUserId: inviteeUserId,
          subjectGroupId: groupId,
          subjectCommunityGroupInviteId: inviteId,
          title:
            response === "accepted"
              ? "accepted your group invite"
              : "declined your group invite",
          presentAt: presentAt ?? undefined,
        },
        select: { id: true },
      });
      await tx.user.update({
        where: { id: inviterUserId },
        data: { undeliveredNotificationCount: { increment: 1 } },
      });
      const undeliveredCount = await tx.notification.count({
        where: this.readState.undeliveredBellWhere(inviterUserId),
      });
      return {
        kind: "created" as const,
        notificationId: created.id,
        undeliveredCount,
      };
    });

    this.support.emitBellAndInvalidateList(inviterUserId, {
      undeliveredCount: result.undeliveredCount,
    });
    try {
      const dto = await this.query.buildNotificationDtoForRecipient({
        recipientUserId: inviterUserId,
        notificationId: result.notificationId,
      });
      if (dto) {
        this.presenceRealtime.emitNotificationNew(inviterUserId, {
          notification: dto,
        });
      }
    } catch (err) {
      this.logger.debug(
        `[notifications] Failed to emit invite response notification: ${err}`,
      );
    }

    // Push for accepted/declined is best-effort; reuse generic flow.
    this.sideEffects.dispatch("notification.push", {
      recipientUserId: inviterUserId,
      kind,
      actorUserId: inviteeUserId,
      fallbackTitle: null,
      body: null,
      subjectPostId: null,
      subjectUserId: null,
      subjectGroupId: groupId,
      subjectCommunityGroupInviteId: inviteId,
      notificationId: result.notificationId,
    });
  }

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

  /**
   * Bulk-create badge-only `community_group_post` notification rows for a new top-level
   * group post. These rows drive the Groups nav badge and per-group card badges — they are
   * excluded from the main notification bell + feed but ARE included in email nudges so
   * members who were offline when the post arrived still get notified.
   *
   * Increments `undeliveredGroupPostCount` (not the bell counter) and emits
   * `groups:unreadChanged` per recipient so badges update in real time.
   */
  async createGroupPostBadgeNotifications(params: {
    actorUserId: string;
    postId: string;
    groupId: string;
    recipientUserIds: string[];
    actorName: string;
    groupName: string;
    bodySnippet?: string;
  }): Promise<void> {
    const {
      actorUserId,
      postId,
      groupId,
      recipientUserIds,
      groupName,
      bodySnippet,
    } = params;
    const now = new Date();
    const toCreate = recipientUserIds.filter((id) => id && id !== actorUserId);
    if (toCreate.length === 0) return;

    // Chunked so a very large group doesn't become one enormous INSERT that holds a
    // connection (and its locks) for seconds.
    for (const slice of chunk(toCreate, FANOUT_CHUNK_SIZE)) {
      await this.prisma.notification.createMany({
        data: slice.map((recipientUserId) => ({
          recipientUserId,
          kind: "community_group_post" as const,
          actorUserId,
          subjectPostId: postId,
          subjectGroupId: groupId,
          title: `posted in ${groupName}`,
          body: bodySnippet ?? null,
          createdAt: now,
        })),
        skipDuplicates: true,
      });
      // New posts don't re-badge the same (recipient, post); increment is safe per recipient.
      await this.prisma.user.updateMany({
        where: { id: { in: slice } },
        data: { undeliveredGroupPostCount: { increment: 1 } },
      });
    }

    const members = await this.prisma.communityGroupMember.findMany({
      where: { groupId, userId: { in: toCreate }, status: "active" },
      select: { userId: true, notificationPreference: true },
    });
    const quietRecipients = new Set(
      members
        .filter(
          (m) => m.notificationPreference && m.notificationPreference !== "all",
        )
        .map((m) => m.userId),
    );

    // Each badge emit is its own count query, so this is bounded rather than one promise
    // per recipient.
    await runInBatches(
      toCreate,
      FANOUT_CONCURRENCY,
      async (recipientUserId) => {
        await this.readState.emitGroupsUnreadForUser(recipientUserId);
        await this.cacheInvalidation?.bumpNotificationsList(recipientUserId);
        const record = await this.prisma.notification.findFirst({
          where: {
            recipientUserId,
            kind: "community_group_post",
            subjectPostId: postId,
          },
          select: { id: true },
        });
        if (record && !quietRecipients.has(recipientUserId)) {
          const dto = await this.query.buildNotificationDtoForRecipient({
            recipientUserId,
            notificationId: record.id,
          });
          if (dto)
            this.presenceRealtime.emitNotificationNew(recipientUserId, {
              notification: dto,
            });
        }
      },
    );
  }
}
