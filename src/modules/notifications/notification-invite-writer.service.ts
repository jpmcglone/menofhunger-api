import { Injectable, Logger } from "@nestjs/common";
import { PrismaService } from "../prisma/prisma.service";
import { PresenceRealtimeService } from "../presence/presence-realtime.service";
import { SideEffectsService } from "../side-effects/side-effects.service";
import { NotificationQueryService } from "./notification-query.service";
import { NotificationReadStateService } from "./notification-read-state.service";
import { NotificationWriterSupportService } from "./notification-writer-support.service";
import { CacheInvalidationService } from "../redis/cache-invalidation.service";
import { type NotificationKind } from "@prisma/client";
import { FANOUT_CONCURRENCY, runInBatches } from "../side-effects/batch";
import { chunk } from "../../common/arrays/chunk";
import { FANOUT_CHUNK_SIZE } from "../side-effects/side-effects.constants";
import { listActiveGroupMemberPreferences } from "../viewer/group-membership.queries";

@Injectable()
export class NotificationInviteWriterService {
  private readonly logger = new Logger(NotificationInviteWriterService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly presenceRealtime: PresenceRealtimeService,
    private readonly sideEffects: SideEffectsService,
    private readonly query: NotificationQueryService,
    private readonly readState: NotificationReadStateService,
    private readonly support: NotificationWriterSupportService,
    private readonly cacheInvalidation?: CacheInvalidationService,
  ) {}

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

    const members = await listActiveGroupMemberPreferences(
      this.prisma,
      groupId,
      toCreate,
    );
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
