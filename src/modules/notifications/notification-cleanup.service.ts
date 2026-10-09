import { Injectable, Inject } from "@nestjs/common";
import { type NotificationKind } from "@prisma/client";
import { PrismaService } from "../prisma/prisma.service";
import { PresenceRealtimeService } from "../presence/presence-realtime.service";

import { SideEffectsService } from "../side-effects/side-effects.service";

import { NotificationReadStateService } from "./notification-read-state.service";
import { CacheInvalidationService } from "../redis/cache-invalidation.service";

import { NotificationWriterSupportService } from "./notification-writer-support.service";

/** Removes obsolete notification rows and synchronizes bell, group, and waiting badges after commit. */
@Injectable()
export class NotificationCleanupService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly presenceRealtime: PresenceRealtimeService,
    private readonly sideEffects: SideEffectsService,
    private readonly readState: NotificationReadStateService,
    private readonly support: NotificationWriterSupportService,
    @Inject(CacheInvalidationService)
    private readonly cacheInvalidation: Pick<
      CacheInvalidationService,
      "bumpNotificationsList"
    >,
  ) {}

  private async deleteNotificationRowsAndEmit(
    rows: Array<{
      id: string;
      recipientUserId: string;
      deliveredAt: Date | null;
      kind?: NotificationKind;
    }>,
  ): Promise<number> {
    const ids = rows.map((r) => r.id).filter(Boolean);
    if (ids.length === 0) return 0;

    // `community_group_post` rows are bell-excluded: they never incremented
    // `undeliveredNotificationCount`, so deleting them must NOT decrement it
    // (that would drift the bell badge). They drive the Groups badge instead.
    const undeliveredDeletedByRecipient = new Map<string, number>();
    const undeliveredGroupDeletedByRecipient = new Map<string, number>();
    const groupBadgeRecipients = new Set<string>();
    for (const r of rows) {
      const uid = (r.recipientUserId ?? "").trim();
      if (!uid) continue;
      if (r.kind === "community_group_post") {
        groupBadgeRecipients.add(uid);
        if (r.deliveredAt == null) {
          undeliveredGroupDeletedByRecipient.set(
            uid,
            (undeliveredGroupDeletedByRecipient.get(uid) ?? 0) + 1,
          );
        }
        continue;
      }
      if (r.deliveredAt != null) continue;
      undeliveredDeletedByRecipient.set(
        uid,
        (undeliveredDeletedByRecipient.get(uid) ?? 0) + 1,
      );
    }

    const updatedCountByRecipient = await this.prisma.$transaction(
      async (tx) => {
        await tx.notification.deleteMany({ where: { id: { in: ids } } });

        const updates = new Map<string, number>();
        for (const [uid, delta] of undeliveredDeletedByRecipient) {
          if (delta <= 0) continue;
          const user = await tx.user.update({
            where: { id: uid },
            data: { undeliveredNotificationCount: { decrement: delta } },
            select: { undeliveredNotificationCount: true },
          });
          updates.set(uid, user.undeliveredNotificationCount);
        }
        for (const [uid, delta] of undeliveredGroupDeletedByRecipient) {
          if (delta <= 0) continue;
          await tx.user.update({
            where: { id: uid },
            data: { undeliveredGroupPostCount: { decrement: delta } },
          });
        }
        return updates;
      },
    );

    const idsByRecipient = new Map<string, string[]>();
    for (const r of rows) {
      const uid = (r.recipientUserId ?? "").trim();
      if (!uid) continue;
      const list = idsByRecipient.get(uid) ?? [];
      list.push(r.id);
      idsByRecipient.set(uid, list);
    }

    for (const [uid, notifIds] of idsByRecipient) {
      this.presenceRealtime.emitNotificationsDeleted(uid, {
        notificationIds: notifIds,
      });
      if (!updatedCountByRecipient.has(uid)) {
        void this.readState.emitNavUnreadForUser(uid);
        this.sideEffects.dispatch("account.cluster.badge", { userId: uid });
        void this.cacheInvalidation.bumpNotificationsList(uid);
      }
    }

    for (const [uid, undeliveredCount] of updatedCountByRecipient) {
      this.support.emitBellAndInvalidateList(uid, { undeliveredCount });
    }

    // Bulk deletes can drop comment notifications (e.g. when the parent post is removed).
    // Recompute the waiting-on-you dot for each affected recipient.
    for (const uid of idsByRecipient.keys()) {
      void this.readState.emitWaitingCountForUser(uid);
    }

    // Deleting a group post drops its `community_group_post` badge rows — refresh the
    // Groups badge for each affected recipient so a stale count doesn't linger.
    for (const uid of groupBadgeRecipients) {
      void this.readState.emitGroupsUnreadForUser(uid);
    }

    return ids.length;
  }

  /** Delete all notifications that reference this post as the subject (post is gone). */
  async deleteBySubjectPostId(subjectPostId: string): Promise<number> {
    const id = (subjectPostId ?? "").trim();
    if (!id) return 0;
    const rows = await this.prisma.notification.findMany({
      where: { subjectPostId: id },
      select: {
        id: true,
        recipientUserId: true,
        deliveredAt: true,
        kind: true,
      },
    });
    return await this.deleteNotificationRowsAndEmit(rows);
  }

  /** Delete all notifications caused by this post (e.g. replies or mentions) using actorPostId. */
  async deleteByActorPostId(actorPostId: string): Promise<number> {
    const id = (actorPostId ?? "").trim();
    if (!id) return 0;
    const rows = await this.prisma.notification.findMany({
      where: { actorPostId: id },
      select: {
        id: true,
        recipientUserId: true,
        deliveredAt: true,
        kind: true,
      },
    });
    return await this.deleteNotificationRowsAndEmit(rows);
  }

  /**
   * Tidy up stale "X joined your crew" / "X accepted your crew invite" notifications
   * when X leaves (or is kicked from) the crew. The fact that X joined is no longer
   * meaningful — recipients will get a fresh `crew_member_left` / `crew_member_kicked`
   * notification instead. Idempotent.
   */
  async deleteCrewJoinedNotificationsForActor(params: {
    crewId: string;
    actorUserId: string;
  }): Promise<number> {
    const crewId = (params.crewId ?? "").trim();
    const actorUserId = (params.actorUserId ?? "").trim();
    if (!crewId || !actorUserId) return 0;
    const rows = await this.prisma.notification.findMany({
      where: {
        subjectCrewId: crewId,
        actorUserId,
        kind: { in: ["crew_member_joined", "crew_invite_accepted"] },
      },
      select: { id: true, recipientUserId: true, deliveredAt: true },
    });
    return await this.deleteNotificationRowsAndEmit(rows);
  }

  /** Delete follow notifications for a relationship (used on unfollow). */
  async deleteFollowNotification(
    recipientUserId: string,
    actorUserId: string,
  ): Promise<number> {
    const recipient = (recipientUserId ?? "").trim();
    const actor = (actorUserId ?? "").trim();
    if (!recipient || !actor) return 0;
    const rows = await this.prisma.notification.findMany({
      where: { recipientUserId: recipient, actorUserId: actor, kind: "follow" },
      select: { id: true, recipientUserId: true, deliveredAt: true },
    });
    return await this.deleteNotificationRowsAndEmit(rows);
  }
}
