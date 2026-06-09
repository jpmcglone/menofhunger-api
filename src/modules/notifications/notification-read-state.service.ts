import { Injectable, Logger } from '@nestjs/common';
import { Prisma, type NotificationKind } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { PresenceRealtimeService } from '../presence/presence-realtime.service';
import { PosthogService } from '../../common/posthog/posthog.service';

export type NotificationUnreadByKind = Partial<Record<NotificationKind | 'all', number>>;

/**
 * Read/delivered state: badge counts, mark-read/mark-delivered flows (by id,
 * by subject, bulk), nudge resolution, and the realtime badge emits that keep
 * every tab in sync.
 */
@Injectable()
export class NotificationReadStateService {
  private readonly logger = new Logger(NotificationReadStateService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly presenceRealtime: PresenceRealtimeService,
    private readonly posthog: PosthogService,
  ) {}

  undeliveredBellWhere(recipientUserId: string): Prisma.NotificationWhereInput {
    return {
      recipientUserId,
      deliveredAt: null,
      kind: { not: 'message' },
    };
  }

  async getUndeliveredCount(recipientUserId: string): Promise<number> {
    // Chat unread state has its own messages badge; the bell count only includes
    // notification feed rows, and deliberately excludes legacy `message` rows.
    return this.prisma.notification.count({
      where: this.undeliveredBellWhere(recipientUserId),
    });
  }

  async getUnreadCountsByKind(recipientUserId: string): Promise<NotificationUnreadByKind> {
    const rows = await this.prisma.notification.groupBy({
      by: ['kind'],
      where: {
        recipientUserId,
        readAt: null,
        kind: { not: 'message' },
      },
      _count: { _all: true },
    });

    const counts: NotificationUnreadByKind = { all: 0 };
    for (const row of rows) {
      const count = row._count._all;
      counts[row.kind] = count;
      counts.all = (counts.all ?? 0) + count;
    }
    return counts;
  }

  /**
   * Count of unread `comment` notifications for a user — drives the "waiting on you" dot
   * on the Home tab. Cheap to compute (kind+readAt are part of the notifications recipient index).
   */
  async getUnreadCommentCount(recipientUserId: string): Promise<number> {
    return this.prisma.notification.count({
      where: { recipientUserId, kind: 'comment', readAt: null },
    });
  }

  /**
   * Recompute the unread-comment count and emit a `notifications:waitingCountChanged` event.
   * Best-effort: never throws; safe to call after any mutation that could affect the count.
   */
  async emitWaitingCountForUser(recipientUserId: string): Promise<void> {
    try {
      const unreadCommentCount = await this.getUnreadCommentCount(recipientUserId);
      this.presenceRealtime.emitNotificationsWaitingChanged(recipientUserId, { unreadCommentCount });
    } catch (err) {
      this.logger.debug(`[notifications] Failed to emit waiting count: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  async markDelivered(recipientUserId: string): Promise<void> {
    const undeliveredCount = await this.prisma.$transaction(async (tx) => {
      const res = await tx.notification.updateMany({
        where: this.undeliveredBellWhere(recipientUserId),
        data: { deliveredAt: new Date() },
      });
      if (res.count > 0) {
        // Clamp to 0 — decrement can't go below 0 even if the counter drifted.
        await tx.$executeRaw`
          UPDATE "User"
          SET "undeliveredNotificationCount" = GREATEST(0, "undeliveredNotificationCount" - ${res.count})
          WHERE id = ${recipientUserId}
        `;
      }
      // Return accurate count from actual rows (handles drifted counters).
      return tx.notification.count({ where: this.undeliveredBellWhere(recipientUserId) });
    });
    this.presenceRealtime.emitNotificationsUpdated(recipientUserId, {
      undeliveredCount,
    });
  }

  async markNewPostsRead(recipientUserId: string): Promise<{ undeliveredCount: number }> {
    const undeliveredCount = await this.prisma.$transaction(async (tx) => {
      const now = new Date();
      const where = {
        recipientUserId,
        kind: 'followed_post' as const,
        OR: [{ readAt: null }, { deliveredAt: null }],
      };
      const deliveredRes = await tx.notification.updateMany({
        where: { ...where, deliveredAt: null },
        data: { deliveredAt: now },
      });
      await tx.notification.updateMany({
        where,
        data: { readAt: now, deliveredAt: now },
      });
      if (deliveredRes.count > 0) {
        await tx.$executeRaw`
          UPDATE "User"
          SET "undeliveredNotificationCount" = GREATEST(0, "undeliveredNotificationCount" - ${deliveredRes.count})
          WHERE id = ${recipientUserId}
        `;
      }
      return tx.notification.count({ where: { recipientUserId, deliveredAt: null } });
    });

    this.presenceRealtime.emitNotificationsUpdated(recipientUserId, {
      undeliveredCount,
    });
    return { undeliveredCount };
  }

  async markReadBySubject(
    recipientUserId: string,
    params: {
      postId?: string | null;
      userId?: string | null;
      articleId?: string | null;
      crewId?: string | null;
      groupId?: string | null;
    },
  ): Promise<void> {
    const { postId, userId, articleId, crewId, groupId } = params;
    if (!postId && !userId && !articleId && !crewId && !groupId) return;

    // Back-compat: followed_post notifications were historically keyed only by actorUserId.
    // When visiting a user's profile we want to clear "new posts" notifications for that actor,
    // even if subjectUserId was not set at creation time.
    const or: Array<Record<string, unknown>> = [];
    if (postId) {
      // Match notifications where this post is the subject (e.g. boost, mention, poll).
      or.push({ subjectPostId: postId });
      // Also match notifications where this post is the actor's post (e.g. comment/reply
      // notifications: subjectPostId = original post, actorPostId = the reply being viewed).
      or.push({ actorPostId: postId });
    }
    if (userId) {
      // Important: do NOT implicitly mark nudges as read when visiting a user's profile.
      // Nudges should only be cleared via explicit actions (ignore / acknowledge / nudge back).
      or.push({ subjectUserId: userId, kind: { not: 'nudge' } });
      or.push({ kind: 'followed_post', actorUserId: userId });
    }
    if (articleId) {
      or.push({ subjectArticleId: articleId });
    }
    if (crewId) {
      // All crew_* notifications carry subjectCrewId once the crew exists. Visiting the
      // crew page surfaces all of them (wall mentions, members joined/left, owner changes,
      // disband notices, invite acceptances/declines), so clear them all in one shot.
      or.push({ subjectCrewId: crewId });
    }
    if (groupId) {
      // Visiting a group page (or the pending-members page) surfaces join requests and
      // any other group-scoped notifications. Clear them all by group id.
      or.push({ subjectGroupId: groupId });
    }
    const where = {
      recipientUserId,
      readAt: null,
      ...(or.length ? { OR: or } : {}),
    } as const;

    const undeliveredCount = await this.prisma.$transaction(async (tx) => {
      const now = new Date();
      await tx.notification.updateMany({
        where,
        data: { readAt: now },
      });

      // Also mark as delivered (seen) when visiting the post/profile, then emit updated count.
      const deliveredWhere = { ...where, deliveredAt: null } as const;
      const deliveredRes = await tx.notification.updateMany({
        where: deliveredWhere,
        data: { deliveredAt: now },
      });
      if (deliveredRes.count > 0) {
        // Clamp to 0 — decrement can't go below 0 even if the counter drifted.
        await tx.$executeRaw`
          UPDATE "User"
          SET "undeliveredNotificationCount" = GREATEST(0, "undeliveredNotificationCount" - ${deliveredRes.count})
          WHERE id = ${recipientUserId}
        `;
      }
      // Return accurate count from actual rows (handles drifted counters).
      return tx.notification.count({ where: { recipientUserId, deliveredAt: null } });
    });
    this.presenceRealtime.emitNotificationsUpdated(recipientUserId, {
      undeliveredCount,
    });
    // markReadBySubject can clear comment notifications (e.g. opening the post via tap).
    void this.emitWaitingCountForUser(recipientUserId);
  }

  /**
   * Mark the recipient's `crew_invite_received` notification for a specific
   * invite as read + delivered. Idempotent and safe to call from any code path
   * that resolves the invite (accept / decline / cancel / expire) so the bell
   * badge clears regardless of which UI surface acted on it.
   */
  async markCrewInviteResolved(
    recipientUserId: string,
    inviteId: string,
  ): Promise<void> {
    const baseWhere = {
      recipientUserId,
      kind: 'crew_invite_received' as const,
      subjectCrewInviteId: inviteId,
    };
    const res = await this.prisma.$transaction(async (tx) => {
      const now = new Date();
      const readRes = await tx.notification.updateMany({
        where: { ...baseWhere, readAt: null },
        data: { readAt: now },
      });
      const deliveredRes = await tx.notification.updateMany({
        where: { ...baseWhere, deliveredAt: null },
        data: { deliveredAt: now },
      });
      if (deliveredRes.count > 0) {
        // Clamp to 0 so a drifted counter can't go negative.
        await tx.$executeRaw`
          UPDATE "User"
          SET "undeliveredNotificationCount" = GREATEST(0, "undeliveredNotificationCount" - ${deliveredRes.count})
          WHERE id = ${recipientUserId}
        `;
      }
      if (readRes.count === 0 && deliveredRes.count === 0) {
        return { changed: false as const, undeliveredCount: null as number | null };
      }
      const undeliveredCount = await tx.notification.count({
        where: { recipientUserId, deliveredAt: null },
      });
      return { changed: true as const, undeliveredCount };
    });
    if (res.changed) {
      this.presenceRealtime.emitNotificationsUpdated(recipientUserId, {
        undeliveredCount: res.undeliveredCount ?? 0,
      });
    }
  }

  async markReadById(
    recipientUserId: string,
    notificationId: string,
  ): Promise<boolean> {
    const notification = await this.prisma.notification.findUnique({
      where: { id: notificationId },
      select: { kind: true },
    });

    const res = await this.prisma.$transaction(async (tx) => {
      const now = new Date();
      const readRes = await tx.notification.updateMany({
        where: { id: notificationId, recipientUserId, readAt: null },
        data: { readAt: now },
      });
      if (readRes.count === 0) return { changed: false as const, undeliveredCount: null as number | null };
      const deliveredRes = await tx.notification.updateMany({
        where: { id: notificationId, recipientUserId, deliveredAt: null },
        data: { deliveredAt: now },
      });
      if (deliveredRes.count > 0) {
        const user = await tx.user.update({
          where: { id: recipientUserId },
          data: { undeliveredNotificationCount: { decrement: deliveredRes.count } },
          select: { undeliveredNotificationCount: true },
        });
        return { changed: true as const, undeliveredCount: user.undeliveredNotificationCount };
      }
      const row = await tx.user.findUnique({
        where: { id: recipientUserId },
        select: { undeliveredNotificationCount: true },
      });
      return { changed: true as const, undeliveredCount: row?.undeliveredNotificationCount ?? 0 };
    });
    if (res.changed) {
      this.presenceRealtime.emitNotificationsUpdated(recipientUserId, {
        undeliveredCount: res.undeliveredCount ?? 0,
      });
      if (notification?.kind === 'comment') {
        void this.emitWaitingCountForUser(recipientUserId);
      }
      this.posthog.capture(recipientUserId, 'notification_tapped', {
        notification_id: notificationId,
        kind: notification?.kind ?? null,
      });
    }
    return res.changed;
  }

  /**
   * Mark a notification as ignored (used for nudges).
   * Semantics:
   * - Clears unread highlight (readAt set)
   * - Clears badge if undelivered (deliveredAt set)
   * - Persists ignoredAt so the sender can remain rate-limited for a while
   */
  async ignoreById(
    recipientUserId: string,
    notificationId: string,
  ): Promise<boolean> {
    const res = await this.prisma.$transaction(async (tx) => {
      const now = new Date();
      const ignoredRes = await tx.notification.updateMany({
        where: { id: notificationId, recipientUserId, ignoredAt: null },
        data: { ignoredAt: now, readAt: now },
      });
      if (ignoredRes.count === 0) return { changed: false as const, undeliveredCount: null as number | null };
      const deliveredRes = await tx.notification.updateMany({
        where: { id: notificationId, recipientUserId, deliveredAt: null },
        data: { deliveredAt: now },
      });
      if (deliveredRes.count > 0) {
        const user = await tx.user.update({
          where: { id: recipientUserId },
          data: { undeliveredNotificationCount: { decrement: deliveredRes.count } },
          select: { undeliveredNotificationCount: true },
        });
        return { changed: true as const, undeliveredCount: user.undeliveredNotificationCount };
      }
      const row = await tx.user.findUnique({
        where: { id: recipientUserId },
        select: { undeliveredNotificationCount: true },
      });
      return { changed: true as const, undeliveredCount: row?.undeliveredNotificationCount ?? 0 };
    });
    if (res.changed) {
      this.presenceRealtime.emitNotificationsUpdated(recipientUserId, {
        undeliveredCount: res.undeliveredCount ?? 0,
      });
    }
    return res.changed;
  }

  async markNudgesReadByActor(
    recipientUserId: string,
    actorUserId: string,
  ): Promise<number> {
    const recipient = (recipientUserId ?? '').trim();
    const actor = (actorUserId ?? '').trim();
    if (!recipient || !actor) return 0;
    const res = await this.prisma.$transaction(async (tx) => {
      const now = new Date();
      const readRes = await tx.notification.updateMany({
        where: {
          recipientUserId: recipient,
          kind: 'nudge',
          actorUserId: actor,
          readAt: null,
        },
        data: { readAt: now },
      });
      if (readRes.count === 0) return { changedCount: 0, undeliveredCount: null as number | null };
      const deliveredRes = await tx.notification.updateMany({
        where: {
          recipientUserId: recipient,
          kind: 'nudge',
          actorUserId: actor,
          deliveredAt: null,
        },
        data: { deliveredAt: now },
      });
      if (deliveredRes.count > 0) {
        const user = await tx.user.update({
          where: { id: recipient },
          data: { undeliveredNotificationCount: { decrement: deliveredRes.count } },
          select: { undeliveredNotificationCount: true },
        });
        return { changedCount: readRes.count, undeliveredCount: user.undeliveredNotificationCount };
      }
      const row = await tx.user.findUnique({
        where: { id: recipient },
        select: { undeliveredNotificationCount: true },
      });
      return { changedCount: readRes.count, undeliveredCount: row?.undeliveredNotificationCount ?? 0 };
    });
    if (res.changedCount > 0) this.presenceRealtime.emitNotificationsUpdated(recipient, { undeliveredCount: res.undeliveredCount ?? 0 });
    return res.changedCount;
  }

  async markNudgesNudgedBackByActor(
    recipientUserId: string,
    actorUserId: string,
  ): Promise<number> {
    const recipient = (recipientUserId ?? '').trim();
    const actor = (actorUserId ?? '').trim();
    if (!recipient || !actor) return 0;
    const res = await this.prisma.$transaction(async (tx) => {
      const now = new Date();
      const nudgedRes = await tx.notification.updateMany({
        where: {
          recipientUserId: recipient,
          kind: 'nudge',
          actorUserId: actor,
          nudgedBackAt: null,
        },
        data: { nudgedBackAt: now, readAt: now },
      });
      if (nudgedRes.count === 0) return { changedCount: 0, undeliveredCount: null as number | null };
      const deliveredRes = await tx.notification.updateMany({
        where: {
          recipientUserId: recipient,
          kind: 'nudge',
          actorUserId: actor,
          deliveredAt: null,
        },
        data: { deliveredAt: now },
      });
      if (deliveredRes.count > 0) {
        const user = await tx.user.update({
          where: { id: recipient },
          data: { undeliveredNotificationCount: { decrement: deliveredRes.count } },
          select: { undeliveredNotificationCount: true },
        });
        return { changedCount: nudgedRes.count, undeliveredCount: user.undeliveredNotificationCount };
      }
      const row = await tx.user.findUnique({
        where: { id: recipient },
        select: { undeliveredNotificationCount: true },
      });
      return { changedCount: nudgedRes.count, undeliveredCount: row?.undeliveredNotificationCount ?? 0 };
    });
    if (res.changedCount > 0) this.presenceRealtime.emitNotificationsUpdated(recipient, { undeliveredCount: res.undeliveredCount ?? 0 });
    return res.changedCount;
  }

  async markNudgeNudgedBackById(
    recipientUserId: string,
    notificationId: string,
  ): Promise<boolean> {
    const res = await this.prisma.$transaction(async (tx) => {
      const now = new Date();
      const nudgedRes = await tx.notification.updateMany({
        where: { id: notificationId, recipientUserId, kind: 'nudge', nudgedBackAt: null },
        data: { nudgedBackAt: now, readAt: now },
      });
      if (nudgedRes.count === 0) return { changed: false as const, undeliveredCount: null as number | null };
      const deliveredRes = await tx.notification.updateMany({
        where: { id: notificationId, recipientUserId, deliveredAt: null },
        data: { deliveredAt: now },
      });
      if (deliveredRes.count > 0) {
        const user = await tx.user.update({
          where: { id: recipientUserId },
          data: { undeliveredNotificationCount: { decrement: deliveredRes.count } },
          select: { undeliveredNotificationCount: true },
        });
        return { changed: true as const, undeliveredCount: user.undeliveredNotificationCount };
      }
      const row = await tx.user.findUnique({
        where: { id: recipientUserId },
        select: { undeliveredNotificationCount: true },
      });
      return { changed: true as const, undeliveredCount: row?.undeliveredNotificationCount ?? 0 };
    });
    if (res.changed) this.presenceRealtime.emitNotificationsUpdated(recipientUserId, { undeliveredCount: res.undeliveredCount ?? 0 });
    return res.changed;
  }

  async ignoreNudgesByActor(
    recipientUserId: string,
    actorUserId: string,
  ): Promise<number> {
    const recipient = (recipientUserId ?? '').trim();
    const actor = (actorUserId ?? '').trim();
    if (!recipient || !actor) return 0;
    const res = await this.prisma.$transaction(async (tx) => {
      const now = new Date();
      const ignoredRes = await tx.notification.updateMany({
        where: {
          recipientUserId: recipient,
          kind: 'nudge',
          actorUserId: actor,
          ignoredAt: null,
        },
        data: { ignoredAt: now, readAt: now },
      });
      if (ignoredRes.count === 0) return { changedCount: 0, undeliveredCount: null as number | null };
      const deliveredRes = await tx.notification.updateMany({
        where: {
          recipientUserId: recipient,
          kind: 'nudge',
          actorUserId: actor,
          deliveredAt: null,
        },
        data: { deliveredAt: now },
      });
      if (deliveredRes.count > 0) {
        const user = await tx.user.update({
          where: { id: recipient },
          data: { undeliveredNotificationCount: { decrement: deliveredRes.count } },
          select: { undeliveredNotificationCount: true },
        });
        return { changedCount: ignoredRes.count, undeliveredCount: user.undeliveredNotificationCount };
      }
      const row = await tx.user.findUnique({
        where: { id: recipient },
        select: { undeliveredNotificationCount: true },
      });
      return { changedCount: ignoredRes.count, undeliveredCount: row?.undeliveredNotificationCount ?? 0 };
    });
    if (res.changedCount > 0) this.presenceRealtime.emitNotificationsUpdated(recipient, { undeliveredCount: res.undeliveredCount ?? 0 });
    return res.changedCount;
  }

  /** Mark all of the user's notifications as read and as seen (clears highlight and badge). */
  async markAllRead(recipientUserId: string): Promise<void> {
    const undeliveredCount = await this.prisma.$transaction(async (tx) => {
      const now = new Date();
      await tx.notification.updateMany({
        where: { recipientUserId, readAt: null, kind: { not: 'message' } },
        data: { readAt: now },
      });
      const deliveredRes = await tx.notification.updateMany({
        where: this.undeliveredBellWhere(recipientUserId),
        data: { deliveredAt: now },
      });
      if (deliveredRes.count > 0) {
        await tx.user.update({
          where: { id: recipientUserId },
          data: { undeliveredNotificationCount: { decrement: deliveredRes.count } },
          select: { undeliveredNotificationCount: true },
        });
        return tx.notification.count({ where: this.undeliveredBellWhere(recipientUserId) });
      }
      return tx.notification.count({ where: this.undeliveredBellWhere(recipientUserId) });
    });
    this.presenceRealtime.emitNotificationsUpdated(recipientUserId, {
      undeliveredCount,
    });
    // markAllRead clears every comment notification too.
    void this.emitWaitingCountForUser(recipientUserId);
  }

  /**
   * Mark the message notification for a conversation as read when the user opens it.
   * Also decrements the undelivered counter if the row was undelivered.
   */
  async markConversationMessageNotificationRead(params: {
    userId: string;
    conversationId: string;
  }): Promise<void> {
    const { userId, conversationId } = params;
    const existing = await this.prisma.notification.findFirst({
      where: { recipientUserId: userId, kind: 'message', subjectConversationId: conversationId, readAt: null },
      select: { id: true, deliveredAt: true },
    });
    if (!existing) return;

    const wasUndelivered = existing.deliveredAt == null;
    await this.prisma.$transaction(async (tx) => {
      const now = new Date();
      await tx.notification.update({
        where: { id: existing.id },
        data: { readAt: now, deliveredAt: existing.deliveredAt ?? now },
      });
      if (wasUndelivered) {
        await tx.user.update({
          where: { id: userId },
          data: { undeliveredNotificationCount: { decrement: 1 } },
        });
      }
    });

    if (wasUndelivered) {
      const undeliveredCount = await this.prisma.notification.count({
        where: { recipientUserId: userId, deliveredAt: null },
      });
      this.presenceRealtime.emitNotificationsUpdated(userId, { undeliveredCount });
    }
    this.presenceRealtime.emitNotificationsDeleted(userId, { notificationIds: [existing.id] });
  }
}
