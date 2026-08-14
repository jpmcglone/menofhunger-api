import { Injectable, Logger } from '@nestjs/common';
import { Prisma, type NotificationKind } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { PresenceRealtimeService } from '../presence/presence-realtime.service';
import { PosthogService } from '../../common/posthog/posthog.service';
import { SideEffectsService } from '../side-effects/side-effects.service';
import { CacheInvalidationService } from '../redis/cache-invalidation.service';

export type NotificationUnreadByKind = Partial<Record<NotificationKind | 'all', number>>;

export const BELL_EXCLUDED_KINDS: NotificationKind[] = ['message', 'community_group_post'];

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

  private emitBellUpdated(
    recipientUserId: string,
    payload: { undeliveredCount: number; clearedPostIds?: string[] },
  ): void {
    this.presenceRealtime.emitNotificationsUpdated(recipientUserId, payload);
    this.dispatchBadgeSync(recipientUserId, { undeliveredBellCount: payload.undeliveredCount });
    void this.cacheInvalidation?.bumpNotificationsList(recipientUserId);
  }

  undeliveredBellWhere(recipientUserId: string): Prisma.NotificationWhereInput {
    return {
      recipientUserId,
      deliveredAt: null,
      kind: { notIn: BELL_EXCLUDED_KINDS },
    };
  }

  async getUndeliveredCount(recipientUserId: string): Promise<number> {
    const user = await this.prisma.user.findUnique({
      where: { id: recipientUserId },
      select: { undeliveredNotificationCount: true },
    });
    return Math.max(0, Math.floor(Number(user?.undeliveredNotificationCount) || 0));
  }

  async getUnreadCountsByKind(recipientUserId: string): Promise<NotificationUnreadByKind> {
    const rows = await this.prisma.notification.groupBy({
      by: ['kind'],
      where: {
        recipientUserId,
        readAt: null,
        kind: { notIn: BELL_EXCLUDED_KINDS },
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
    } catch (err) {
      this.logger.debug(`[notifications] Failed to emit groups unread: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  /**
   * Mark `community_group_post` rows for a specific group as seen (deliveredAt set)
   * but NOT read (readAt left null). Called when the user opens a group page.
   * Read is set separately when the post is actually viewed on screen via `markReadBySubject({ postId })`.
   */
  async markGroupPostsDelivered(recipientUserId: string, groupId: string): Promise<void> {
    const deliveredRes = await this.prisma.$transaction(async (tx) => {
      const res = await tx.notification.updateMany({
        where: {
          recipientUserId,
          kind: 'community_group_post',
          subjectGroupId: groupId,
          deliveredAt: null,
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
      // Also mark group-post badge rows as delivered (opening notifications clears all badges).
      const groupRes = await tx.notification.updateMany({
        where: { recipientUserId, kind: 'community_group_post', deliveredAt: null },
        data: { deliveredAt: new Date() },
      });
      if (groupRes.count > 0) {
        await tx.$executeRaw`
          UPDATE "User"
          SET "undeliveredGroupPostCount" = GREATEST(0, "undeliveredGroupPostCount" - ${groupRes.count})
          WHERE id = ${recipientUserId}
        `;
      }
      // Return accurate count from actual rows (handles drifted counters).
      return tx.notification.count({ where: this.undeliveredBellWhere(recipientUserId) });
    });
    this.emitBellUpdated(recipientUserId, {
      undeliveredCount,
    });
    // Groups badges also clear when the user opens the notifications page.
    void this.emitGroupsUnreadForUser(recipientUserId);
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
    // Batch path for post-only clears (views, detail page).
    if (postId && !userId && !articleId && !crewId && !groupId) {
      await this.markReadBySubjects(recipientUserId, [postId]);
      return;
    }
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
      or.push({ kind: { in: ['followed_post', 'checkin_post'] as const }, actorUserId: userId });
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
      // any other group-scoped notifications. Clear them all by group id — but NOT
      // community_group_post badge rows, which are only "seen" (deliveredAt) on group
      // open via markGroupPostsDelivered, and "read" only when the post is actually viewed.
      or.push({ subjectGroupId: groupId, kind: { not: 'community_group_post' as const } });
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

      // Deliver bell-counted matching rows (do not require readAt:null — we just set it).
      const deliveredRes = await tx.notification.updateMany({
        where: {
          recipientUserId,
          deliveredAt: null,
          kind: { notIn: BELL_EXCLUDED_KINDS },
          ...(or.length ? { OR: or } : {}),
        },
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
      return tx.notification.count({ where: this.undeliveredBellWhere(recipientUserId) });
    });
    this.emitBellUpdated(recipientUserId, {
      undeliveredCount,
      ...(postId ? { clearedPostIds: [postId] } : {}),
    });
    // markReadBySubject can clear comment notifications (e.g. opening the post via tap).
    void this.emitWaitingCountForUser(recipientUserId);
  }

  /**
   * Mark notifications for many posts as read+seen in one shot (feed view batches).
   * Single updateMany, one notifications:updated with clearedPostIds, one badge.sync.
   */
  async markReadBySubjects(recipientUserId: string, postIds: string[]): Promise<void> {
    const uid = (recipientUserId ?? '').trim();
    const ids = [...new Set((postIds ?? []).map((id) => (id ?? '').trim()).filter(Boolean))];
    if (!uid || ids.length === 0) return;

    const postOr = [{ subjectPostId: { in: ids } }, { actorPostId: { in: ids } }] as const;

    const { undeliveredCount, groupsDelivered, readChanged, bellDelivered } =
      await this.prisma.$transaction(async (tx) => {
        const now = new Date();
        const readRes = await tx.notification.updateMany({
          where: {
            recipientUserId: uid,
            readAt: null,
            OR: [...postOr],
          },
          data: { readAt: now },
        });

        const deliveredBell = await tx.notification.updateMany({
          where: {
            recipientUserId: uid,
            deliveredAt: null,
            kind: { notIn: BELL_EXCLUDED_KINDS },
            OR: [...postOr],
          },
          data: { deliveredAt: now },
        });
        if (deliveredBell.count > 0) {
          await tx.$executeRaw`
            UPDATE "User"
            SET "undeliveredNotificationCount" = GREATEST(0, "undeliveredNotificationCount" - ${deliveredBell.count})
            WHERE id = ${uid}
          `;
        }

        // Viewing a post also marks matching community_group_post badge rows delivered+read.
        const deliveredGroups = await tx.notification.updateMany({
          where: {
            recipientUserId: uid,
            kind: 'community_group_post',
            deliveredAt: null,
            OR: [...postOr],
          },
          data: { deliveredAt: now, readAt: now },
        });
        if (deliveredGroups.count > 0) {
          await tx.$executeRaw`
            UPDATE "User"
            SET "undeliveredGroupPostCount" = GREATEST(0, "undeliveredGroupPostCount" - ${deliveredGroups.count})
            WHERE id = ${uid}
          `;
        }

        // Skip expensive count when nothing changed (idempotent re-views).
        if (readRes.count === 0 && deliveredBell.count === 0 && deliveredGroups.count === 0) {
          return {
            undeliveredCount: 0,
            groupsDelivered: 0,
            readChanged: 0,
            bellDelivered: 0,
          };
        }

        const undelivered = await tx.notification.count({ where: this.undeliveredBellWhere(uid) });
        return {
          undeliveredCount: undelivered,
          groupsDelivered: deliveredGroups.count,
          readChanged: readRes.count,
          bellDelivered: deliveredBell.count,
        };
      });

    // Idempotent re-views: no socket/badge work when nothing was unread/undelivered.
    if (readChanged === 0 && bellDelivered === 0 && groupsDelivered === 0) return;

    this.emitBellUpdated(uid, {
      undeliveredCount,
      clearedPostIds: ids,
    });
    void this.emitWaitingCountForUser(uid);
    if (groupsDelivered > 0) {
      void this.emitGroupsUnreadForUser(uid);
    }
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
      this.emitBellUpdated(recipientUserId, {
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
      this.emitBellUpdated(recipientUserId, {
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
      this.emitBellUpdated(recipientUserId, {
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
    if (res.changedCount > 0) this.emitBellUpdated(recipient, { undeliveredCount: res.undeliveredCount ?? 0 });
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
    if (res.changedCount > 0) this.emitBellUpdated(recipient, { undeliveredCount: res.undeliveredCount ?? 0 });
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
    if (res.changed) this.emitBellUpdated(recipientUserId, { undeliveredCount: res.undeliveredCount ?? 0 });
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
    if (res.changedCount > 0) this.emitBellUpdated(recipient, { undeliveredCount: res.undeliveredCount ?? 0 });
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
