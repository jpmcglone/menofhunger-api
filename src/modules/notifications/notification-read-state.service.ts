import type { NotificationsUpdatedPayloadDto } from "../../common/dto";
import { Injectable, Logger } from '@nestjs/common';
import { Prisma, type NotificationKind } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { PresenceRealtimeService } from '../presence/presence-realtime.service';
import { PosthogService } from '../../common/posthog/posthog.service';
import { SideEffectsService } from '../side-effects/side-effects.service';
import { CacheInvalidationService } from '../redis/cache-invalidation.service';
import { boardActivityWhere, notificationFilterWhere, withoutBoardActivity } from './notification-category';

export type NotificationUnreadByKind = Partial<Record<NotificationKind | 'all', number>>;

import { BELL_EXCLUDED_KINDS } from './notification-kinds';
export { BELL_EXCLUDED_KINDS, PERSON_ONLY_NOTIFICATION_KINDS, bellExcludedKindsForAccount } from './notification-kinds';
import { BadgeSummaryService } from '../../common/badges/badge-summary.service';

/**
 * Notification kinds that are counted in the bell badge but must never trigger
 * nudge/instant emails. Daily content notifications are bell-counted so users
 * can clear them, but they are not "missed social activity" that warrants an email.
 */
export const EMAIL_EXCLUDED_KINDS: NotificationKind[] = [
  'message',
  'community_group_post',
  'word_of_the_day',
  'quote_of_the_day',
  'checkin_reminder',
  'on_this_day',
];

export function isBellCountedNotificationKind(kind: NotificationKind): boolean {
  return !BELL_EXCLUDED_KINDS.includes(kind);
}

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
    private readonly sideEffects: SideEffectsService,
    private readonly cacheInvalidation?: CacheInvalidationService,
    private readonly badges: BadgeSummaryService = new BadgeSummaryService(prisma),
  ) {}

  /** Queue badge-only APNs (debounced in the worker). Never throws. */
  private dispatchBadgeSync(
    recipientUserId: string,
    hints?: { undeliveredBellCount?: number; undeliveredGroupsCount?: number },
  ): void {
    this.sideEffects.dispatch('notification.badge.sync', {
      recipientUserId,
      ...(typeof hints?.undeliveredBellCount === 'number'
        ? { undeliveredBellCount: hints.undeliveredBellCount }
        : {}),
      ...(typeof hints?.undeliveredGroupsCount === 'number'
        ? { undeliveredGroupsCount: hints.undeliveredGroupsCount }
        : {}),
    });
  }

  /** Drop lock-screen banners for a section the user just viewed. Never throws. */
  dispatchLockScreenClear(recipientUserId: string, section: 'inbox' | 'groups'): void {
    this.presenceRealtime.emitNotificationsLockScreenClear(recipientUserId, { section });
    this.sideEffects.dispatch('notification.lockScreen.clear', { recipientUserId, section });
  }

  emitBellUpdated(
    recipientUserId: string,
    payload: NotificationsUpdatedPayloadDto,
  ): void {
    this.presenceRealtime.emitNotificationsUpdated(recipientUserId, payload);
    this.dispatchBadgeSync(recipientUserId, { undeliveredBellCount: payload.undeliveredCount });
    this.sideEffects.dispatch('account.cluster.badge', { userId: recipientUserId });
    void this.cacheInvalidation?.bumpNotificationsList(recipientUserId);
    void this.emitNavUnreadForUser(recipientUserId);
  }

  /**
   * Single-row paths read the denormalized counter, which still includes Board rows.
   * Recount the bell so Board activity never leaks into the emitted number.
   */
  async emitBellRecounted(recipientUserId: string, fallback?: number | null): Promise<void> {
    let undeliveredCount = fallback ?? 0;
    try {
      undeliveredCount = await this.getUndeliveredCount(recipientUserId);
    } catch {
      // Keep the counter-derived fallback.
    }
    this.emitBellUpdated(recipientUserId, { undeliveredCount });
  }

  /**
   * Navigation state. Board owns its own numbers: unread dot (`boardUnreadCount`) and unseen
   * mentions (`boardMentionCount`). The notifications dot never includes Board activity.
   */
  async getNavUnread(recipientUserId: string) {
    const where = await this.badges.notificationWhere(recipientUserId);
    const bell = withoutBoardActivity(where);
    const board = { AND: [where, boardActivityWhere(), { actorUserId: { not: recipientUserId } }] };
    const [boardUnreadCount, boardMentionCount, articlesUnreadCount, unread] = await Promise.all([
      this.prisma.notification.count({ where: { ...board, readAt: null } }),
      this.prisma.notification.count({ where: { ...board, kind: 'mention', deliveredAt: null } }),
      this.prisma.notification.count({ where: { ...bell, readAt: null, ...notificationFilterWhere('articles') } }),
      this.prisma.notification.findFirst({ where: { ...bell, readAt: null }, select: { id: true } }),
    ]);
    return { boardUnreadCount, boardMentionCount, articlesUnreadCount, hasUnreadNotifications: unread != null };
  }

  /** Best-effort `notifications:navUnreadChanged` emit; never throws. */
  async emitNavUnreadForUser(recipientUserId: string): Promise<void> {
    try {
      const [counts, undeliveredCount] = await Promise.all([
        this.getNavUnread(recipientUserId), this.getUndeliveredCount(recipientUserId),
      ]);
      this.presenceRealtime.emitNotificationsNavUnreadChanged(recipientUserId, { ...counts, undeliveredCount });
    } catch (err) {
      this.logger.debug(`[notifications] Failed to emit nav unread: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  undeliveredBellWhere(recipientUserId: string): Prisma.NotificationWhereInput {
    return {
      recipientUserId,
      deliveredAt: null,
      kind: { notIn: BELL_EXCLUDED_KINDS },
      NOT: boardActivityWhere(),
    };
  }

  async getUndeliveredCount(recipientUserId: string): Promise<number> {
    return this.prisma.notification.count({
      where: { ...await this.badges.bellWhere(recipientUserId), deliveredAt: null },
    });
  }

  async getUnreadCountsByKind(recipientUserId: string, blockedActorIds: string[] = []): Promise<NotificationUnreadByKind> {
    const rows = await this.prisma.notification.groupBy({
      by: ['kind'],
      where: withoutBoardActivity({
        recipientUserId,
        readAt: null,
        ...(blockedActorIds.length ? { NOT: { AND: [{ actorUserId: { not: null } }, { actorUserId: { in: blockedActorIds } }] } } : {}),
      }),
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

  /**
   * Count of undelivered (unseen) `community_group_post` badge rows, grouped by
   * subjectGroupId. Drives the Groups nav badge total and per-group card badges.
   */
  async getGroupsUnread(recipientUserId: string): Promise<{ total: number; byGroupId: Record<string, number> }> {
    const rows = await this.prisma.notification.groupBy({
      by: ['subjectGroupId'],
      where: {
        recipientUserId,
        kind: 'community_group_post',
        deliveredAt: null,
      },
      _count: { _all: true },
    });
    const byGroupId: Record<string, number> = {};
    let total = 0;
    for (const row of rows) {
      if (!row.subjectGroupId) continue;
      const count = row._count._all;
      byGroupId[row.subjectGroupId] = count;
      total += count;
    }
    return { total, byGroupId };
  }

  /**
   * Recompute the groups unread counts and emit a `groups:unreadChanged` event.
   * Best-effort: never throws.
   */
  async emitGroupsUnreadForUser(recipientUserId: string): Promise<void> {
    try {
      const { total, byGroupId } = await this.getGroupsUnread(recipientUserId);
      this.presenceRealtime.emitGroupsUnreadChanged(recipientUserId, { total, byGroupId });
      this.dispatchBadgeSync(recipientUserId, { undeliveredGroupsCount: total });
      this.sideEffects.dispatch('account.cluster.badge', { userId: recipientUserId });
    } catch (err) {
      this.logger.debug(`[notifications] Failed to emit groups unread: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  /**
   * Mark `community_group_post` rows for a specific group as seen (deliveredAt set)
   * but NOT read (readAt left null). Called when the user opens a group page.
   * Read is set separately when the post is actually viewed on screen via `markReadBySubject({ postId })`.
   */
  async markGroupPostsDelivered(recipientUserId: string, groupId: string, through?: Date): Promise<void> {
    const deliveredRes = await this.prisma.$transaction(async (tx) => {
      const res = await tx.notification.updateMany({
        where: {
          recipientUserId,
          kind: 'community_group_post',
          subjectGroupId: groupId,
          deliveredAt: null,
          ...(through ? { createdAt: { lte: through } } : {}),
        },
        data: { deliveredAt: new Date() },
      });
      if (res.count > 0) {
        await tx.$executeRaw`
          UPDATE "User"
          SET "undeliveredGroupPostCount" = GREATEST(0, "undeliveredGroupPostCount" - ${res.count})
          WHERE id = ${recipientUserId}
        `;
      }
      return res.count;
    });
    if (deliveredRes > 0) {
      void this.emitGroupsUnreadForUser(recipientUserId);
    }
    this.dispatchLockScreenClear(recipientUserId, 'groups');
  }

  async markDelivered(recipientUserId: string, filter?: 'board'): Promise<void> {
    const now = new Date();
    const undeliveredCount = await this.prisma.$transaction(async (tx) => {
      const res = await tx.notification.updateMany({
        where: filter
          ? { recipientUserId, deliveredAt: null, kind: { notIn: BELL_EXCLUDED_KINDS }, ...notificationFilterWhere(filter), createdAt: { lte: now } }
          : { ...this.undeliveredBellWhere(recipientUserId), createdAt: { lte: now } },
        data: { deliveredAt: now },
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
    this.emitBellUpdated(recipientUserId, {
      undeliveredCount,
    });
    // Inbox only — group lock-screen banners stay until the user opens Groups.
    if (!filter) this.dispatchLockScreenClear(recipientUserId, 'inbox');
  }

  async markNewPostsRead(recipientUserId: string): Promise<{ undeliveredCount: number }> {
    const undeliveredCount = await this.prisma.$transaction(async (tx) => {
      const now = new Date();
      const baseWhere = {
        recipientUserId,
        kind: { in: ['followed_post' as const, 'checkin_post' as const] },
      };
      const deliveredRes = await tx.notification.updateMany({
        where: { ...baseWhere, deliveredAt: null },
        data: { deliveredAt: now },
      });
      await tx.notification.updateMany({
        where: { ...baseWhere, OR: [{ readAt: null }, { deliveredAt: null }] },
        data: { readAt: now, deliveredAt: now },
      });
      if (deliveredRes.count > 0) {
        await tx.$executeRaw`
          UPDATE "User"
          SET "undeliveredNotificationCount" = GREATEST(0, "undeliveredNotificationCount" - ${deliveredRes.count})
          WHERE id = ${recipientUserId}
        `;
      }
      return tx.notification.count({ where: this.undeliveredBellWhere(recipientUserId) });
    });

    this.emitBellUpdated(recipientUserId, {
      undeliveredCount,
    });
    return { undeliveredCount };
  }

  /** Explicit bulk read, including unloaded rows, bounded to activity existing at invocation. */
  async markReadByFilter(recipientUserId: string, filter: 'board' | 'articles'): Promise<void> {
    const now = new Date();
    const where = {
      recipientUserId,
      createdAt: { lte: now },
      kind: { notIn: BELL_EXCLUDED_KINDS },
      ...notificationFilterWhere(filter),
    } as const;
    const undeliveredCount = await this.prisma.$transaction(async (tx) => {
      const delivered = await tx.notification.updateMany({
        where: { ...where, deliveredAt: null }, data: { deliveredAt: now },
      });
      await tx.notification.updateMany({ where: { ...where, readAt: null }, data: { readAt: now } });
      if (delivered.count > 0) {
        await tx.$executeRaw`
          UPDATE "User" SET "undeliveredNotificationCount" = GREATEST(0, "undeliveredNotificationCount" - ${delivered.count})
          WHERE id = ${recipientUserId}
        `;
      }
      return tx.notification.count({ where: this.undeliveredBellWhere(recipientUserId) });
    });
    this.emitBellUpdated(recipientUserId, { undeliveredCount });
  }

  /**
   * Mark all unread notifications of the given kind as read + delivered for the recipient.
   * Used by daily-content pages (word / quote) to clear the badge when the user views them.
   */
  async markReadByKind(recipientUserId: string, kind: NotificationKind): Promise<void> {
    const where = { recipientUserId, kind, readAt: null } as const;
    const undeliveredCount = await this.prisma.$transaction(async (tx) => {
      const now = new Date();
      await tx.notification.updateMany({ where, data: { readAt: now } });
      const deliveredWhere = { ...where, deliveredAt: null } as const;
      const deliveredRes = await tx.notification.updateMany({
        where: deliveredWhere,
        data: { deliveredAt: now },
      });
      if (deliveredRes.count > 0) {
        await tx.$executeRaw`
          UPDATE "User"
          SET "undeliveredNotificationCount" = GREATEST(0, "undeliveredNotificationCount" - ${deliveredRes.count})
          WHERE id = ${recipientUserId}
        `;
      }
      return tx.notification.count({ where: this.undeliveredBellWhere(recipientUserId) });
    });
    this.emitBellUpdated(recipientUserId, { undeliveredCount });
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
        where: this.undeliveredBellWhere(recipientUserId),
      });
      return { changed: true as const, undeliveredCount };
    });
    if (res.changed) {
      await this.emitBellRecounted(recipientUserId, res.undeliveredCount);
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
      await this.emitBellRecounted(recipientUserId, res.undeliveredCount);
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
      await this.emitBellRecounted(recipientUserId, res.undeliveredCount);
    }
    return res.changed;
  }

  /** Mark all of the user's notifications as read and as seen (clears highlight and badge). */
  async markAllRead(recipientUserId: string): Promise<void> {
    const now = new Date();
    const undeliveredCount = await this.prisma.$transaction(async (tx) => {
      await tx.notification.updateMany({
        where: withoutBoardActivity({ recipientUserId, readAt: null, createdAt: { lte: now } }),
        data: { readAt: now },
      });
      const deliveredRes = await tx.notification.updateMany({
        where: { ...this.undeliveredBellWhere(recipientUserId), createdAt: { lte: now } },
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
    this.emitBellUpdated(recipientUserId, {
      undeliveredCount,
    });
    // markAllRead clears every comment notification too.
    void this.emitWaitingCountForUser(recipientUserId);
    // Also clear groups badges.
    void this.emitGroupsUnreadForUser(recipientUserId);
  }

  /**
   * Mark the message notification for a conversation as read when the user opens it.
   * Message rows use the Messages badge and never affect the notification-bell counter.
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

    const now = new Date();
    await this.prisma.notification.update({
      where: { id: existing.id },
      data: { readAt: now, deliveredAt: existing.deliveredAt ?? now },
    });
    this.presenceRealtime.emitNotificationsDeleted(userId, { notificationIds: [existing.id] });
  }
}
