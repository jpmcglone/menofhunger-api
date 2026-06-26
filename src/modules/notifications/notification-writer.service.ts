import { Injectable, Logger } from '@nestjs/common';
import { Prisma, type NotificationKind } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { PresenceRealtimeService } from '../presence/presence-realtime.service';
import { JobsService } from '../jobs/jobs.service';
import { JOBS } from '../jobs/jobs.constants';
import { NotificationPushService } from './notification-push.service';
import { NotificationQueryService } from './notification-query.service';
import { NotificationReadStateService } from './notification-read-state.service';

export type CreateNotificationParams = {
  recipientUserId: string;
  kind: NotificationKind;
  actorUserId?: string | null;
  actorPostId?: string | null;
  subjectPostId?: string | null;
  subjectUserId?: string | null;
  subjectArticleId?: string | null;
  subjectArticleCommentId?: string | null;
  subjectGroupId?: string | null;
  subjectCrewId?: string | null;
  subjectCrewInviteId?: string | null;
  subjectCommunityGroupInviteId?: string | null;
  subjectConversationId?: string | null;
  title?: string | null;
  body?: string | null;
};

/**
 * Notification row writes: create + the upsert families (boost, repost, group
 * invites, group/crew lifecycle) and bulk deletes. Owns the post-write fan-out
 * (badge emit, `notifications:new` payload emit, web push, instant email).
 */
@Injectable()
export class NotificationWriterService {
  private readonly logger = new Logger(NotificationWriterService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly presenceRealtime: PresenceRealtimeService,
    private readonly jobs: JobsService,
    private readonly push: NotificationPushService,
    private readonly query: NotificationQueryService,
    private readonly readState: NotificationReadStateService,
  ) {}

  /** True if recipient already has a follow notification from actor within the last withinMs. Use to avoid spam when someone unfollows then follows again. */
  async hasRecentFollowNotification(
    recipientUserId: string,
    actorUserId: string,
    withinMs: number,
  ): Promise<boolean> {
    const since = new Date(Date.now() - withinMs);
    const existing = await this.prisma.notification.findFirst({
      where: {
        recipientUserId,
        actorUserId,
        kind: 'follow',
        createdAt: { gte: since },
      },
      select: { id: true },
    });
    return Boolean(existing);
  }

  async create(params: CreateNotificationParams) {
    const {
      recipientUserId,
      kind,
      actorUserId,
      actorPostId,
      subjectPostId,
      subjectUserId,
      subjectArticleId,
      subjectArticleCommentId,
      subjectGroupId,
      subjectCrewId,
      subjectCrewInviteId,
      subjectCommunityGroupInviteId,
      subjectConversationId,
      title,
      body,
    } = params;

    // Never notify a user about their own actions — regardless of which call-site triggered this.
    if (actorUserId && actorUserId === recipientUserId) return;

    const fallbackTitle =
      title ??
      ({
        follow: 'followed you',
        boost: 'boosted your post',
        followed_post: 'posted',
        followed_article: 'published an article',
        mention: 'mentioned you',
        comment: 'replied to you',
        poll_results_ready: 'Poll results are ready',
        coin_transfer: 'sent you coins',
        message: 'sent you a message',
        group_join_request: 'requests to join your group',
        community_group_member_joined: 'joined the group',
        community_group_join_approved: 'Your join request was approved',
        community_group_join_rejected: 'Your join request was not accepted',
        community_group_member_removed: 'You were removed from a group',
        community_group_disbanded: 'A group you were in was disbanded',
        crew_invite_received: 'invited you to their crew',
        crew_invite_accepted: 'accepted your crew invite',
        crew_invite_declined: 'declined your crew invite',
        crew_invite_cancelled: 'cancelled their crew invite',
        crew_member_joined: 'joined your crew',
        crew_member_left: 'left your crew',
        crew_member_kicked: 'was removed from your crew',
        crew_owner_transferred: 'Crew ownership transferred',
        crew_owner_transfer_vote: 'started a vote to transfer ownership',
        crew_wall_mention: 'mentioned you on the crew wall',
        crew_disbanded: 'Your crew was disbanded',
        community_group_invite_received: 'invited you to their group',
        community_group_invite_accepted: 'accepted your group invite',
        community_group_invite_declined: 'declined your group invite',
        community_group_invite_cancelled: 'cancelled their group invite',
        marv_not_in_group: '@marv is not in this group',
      } as Partial<Record<NotificationKind, string>>)[kind] ??
      null;

    const { notification, undeliveredCount } = await this.prisma.$transaction(async (tx) => {
      const notification = await tx.notification.create({
        data: {
          recipientUserId,
          kind,
          actorUserId: actorUserId ?? undefined,
          actorPostId: actorPostId ?? undefined,
          subjectPostId: subjectPostId ?? undefined,
          subjectUserId: subjectUserId ?? undefined,
          subjectArticleId: subjectArticleId ?? undefined,
          subjectArticleCommentId: subjectArticleCommentId ?? undefined,
          subjectGroupId: subjectGroupId ?? undefined,
          subjectCrewId: subjectCrewId ?? undefined,
          subjectCrewInviteId: subjectCrewInviteId ?? undefined,
          subjectCommunityGroupInviteId: subjectCommunityGroupInviteId ?? undefined,
          subjectConversationId: subjectConversationId ?? undefined,
          title: fallbackTitle ?? undefined,
          body: body ?? undefined,
        },
      });
      // Increment the denormalized counter for bookkeeping, but compute the real undelivered
      // count from actual rows to emit an accurate realtime badge (counter can drift over time).
      await tx.user.update({
        where: { id: recipientUserId },
        data: { undeliveredNotificationCount: { increment: 1 } },
      });
      const undeliveredCount = await tx.notification.count({
        where: { recipientUserId, deliveredAt: null },
      });
      return { notification, undeliveredCount };
    });

    this.presenceRealtime.emitNotificationsUpdated(recipientUserId, {
      undeliveredCount,
    });

    // "Waiting on you" dot: a new reply just landed for this user — recompute the count.
    if (kind === 'comment') {
      void this.readState.emitWaitingCountForUser(recipientUserId);
    }

    // Also emit the full notification payload so clients can update in-place without refetch.
    try {
      const dto = await this.query.buildNotificationDtoForRecipient({
        recipientUserId,
        notificationId: notification.id,
      });
      if (dto) {
        this.presenceRealtime.emitNotificationNew(recipientUserId, { notification: dto });
      }
    } catch (err) {
      // Best-effort: never fail notification creation on realtime emission.
      this.logger.debug(`[notifications] Failed to emit notifications:new: ${err}`);
    }

    // Web push is optional (VAPID + user preference).
    const commentHash = subjectArticleCommentId ? `#comment-${subjectArticleCommentId}` : '';
    // Route to the article page for all article-related notification kinds.
    const pushUrl = subjectArticleId && (
      kind === 'comment' || kind === 'mention' || kind === 'followed_article' || kind === 'boost'
    )
      ? `/a/${subjectArticleId}${commentHash}`
      : kind === 'comment' && actorPostId
        ? `/p/${actorPostId}`
        : kind === 'mention' && actorPostId
          ? `/p/${actorPostId}`
          : kind === 'boost' && subjectPostId
            ? `/p/${subjectPostId}`
            : kind === 'coin_transfer'
              ? '/coins'
              : null;
    // Intentionally omit sourceLabel for actor-driven pushes: the actor's words
    // (snippet) are the most valuable byte budget. sourceLabel is reserved for
    // system-originated pushes (streak reminders, daily prompt, message channel).
    void this.push.sendKindPushForActor({
      recipientUserId,
      kind,
      actorUserId: actorUserId ?? null,
      fallbackTitle,
      body,
      subjectArticleId: subjectArticleId ?? null,
      subjectPostId: subjectPostId ?? null,
      subjectUserId: subjectUserId ?? null,
      url: pushUrl,
      notificationId: notification.id,
    });

    // Optional: enqueue instant email for high-signal events (mentions + replies).
    if (kind === 'mention' || kind === 'comment') {
      try {
        await this.jobs.enqueueCron(
          JOBS.notificationsInstantHighSignalEmail,
          { userId: recipientUserId },
          `notifications:instantHighSignalEmail:${recipientUserId}`,
          {
            delay: 2 * 60_000,
            attempts: 2,
            backoff: { type: 'exponential', delay: 60_000 },
          },
        );
      } catch {
        // likely duplicate jobId; treat as no-op (batching).
      }
    }

    return notification;
  }

  /** Find existing boost notification for (recipient, actor, subject post). */
  async findExistingBoostNotification(
    recipientUserId: string,
    actorUserId: string,
    subjectPostId: string,
  ) {
    return this.prisma.notification.findFirst({
      where: {
        recipientUserId,
        actorUserId,
        subjectPostId,
        kind: 'boost',
      },
      select: { id: true, deliveredAt: true, readAt: true },
    });
  }

  /**
   * Create or overwrite boost notification: if one exists, update createdAt and body only
   * (surfaces to top; does not change delivered/read). Otherwise create.
   */
  async upsertBoostNotification(params: {
    recipientUserId: string;
    actorUserId: string;
    subjectPostId: string;
    bodySnippet?: string | null;
  }) {
    const { recipientUserId, actorUserId, subjectPostId, bodySnippet } = params;
    const maxAttempts = 3;
    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      try {
        const res = await this.prisma.$transaction(
          async (tx) => {
            const existing = await tx.notification.findFirst({
              where: {
                recipientUserId,
                actorUserId,
                subjectPostId,
                kind: 'boost',
              },
              select: { id: true, deliveredAt: true, readAt: true },
            });

            if (existing) {
              await tx.notification.update({
                where: { id: existing.id },
                data: { createdAt: new Date(), body: bodySnippet ?? undefined },
              });
              return { kind: 'updated' as const, notificationId: existing.id, undeliveredCount: null as number | null };
            }

            const notification = await tx.notification.create({
              data: {
                recipientUserId,
                kind: 'boost',
                actorUserId,
                subjectPostId,
                title: 'boosted your post',
                body: bodySnippet ?? undefined,
              },
              select: { id: true },
            });
            await tx.user.update({
              where: { id: recipientUserId },
              data: { undeliveredNotificationCount: { increment: 1 } },
            });
            const undeliveredCount = await tx.notification.count({
              where: { recipientUserId, deliveredAt: null },
            });
            return {
              kind: 'created' as const,
              notificationId: notification.id,
              undeliveredCount,
            };
          },
          { isolationLevel: Prisma.TransactionIsolationLevel.Serializable },
        );

        if (res.kind === 'created' && typeof res.undeliveredCount === 'number') {
          this.presenceRealtime.emitNotificationsUpdated(recipientUserId, { undeliveredCount: res.undeliveredCount });
        }

        // Treat as a new notification row for UI ordering (without changing delivered/read).
        try {
          const dto = await this.query.buildNotificationDtoForRecipient({
            recipientUserId,
            notificationId: res.notificationId,
          });
          if (dto) {
            this.presenceRealtime.emitNotificationNew(recipientUserId, { notification: dto });
          }
        } catch {
          // Best-effort
        }

        // Web push is optional (VAPID + user preference). (Boosts are high-signal.)
        if (res.kind === 'created') {
          void this.push.sendKindPushForActor({
            recipientUserId,
            kind: 'boost',
            actorUserId,
            fallbackTitle: 'boosted your post',
            body: bodySnippet ?? null,
            subjectPostId: subjectPostId ?? null,
            subjectUserId: null,
          });
        }

        return;
      } catch (err: unknown) {
        const code = (err as any)?.code as string | undefined;
        const isRetryable = code === 'P2034' || /could not serialize access/i.test(String((err as any)?.message ?? err));
        if (attempt < maxAttempts && isRetryable) continue;
        throw err;
      }
    }
  }

  /** Remove boost notification when user unboosts; emit updated count if the removed one was undelivered. */
  async deleteBoostNotification(
    recipientUserId: string,
    actorUserId: string,
    subjectPostId: string,
  ): Promise<void> {
    const existing = await this.findExistingBoostNotification(recipientUserId, actorUserId, subjectPostId);
    if (!existing) return;
    const wasUndelivered = existing.deliveredAt == null;
    const undeliveredCount = await this.prisma.$transaction(async (tx) => {
      await tx.notification.delete({ where: { id: existing.id } });
      if (!wasUndelivered) {
        const row = await tx.user.findUnique({
          where: { id: recipientUserId },
          select: { undeliveredNotificationCount: true },
        });
        return row?.undeliveredNotificationCount ?? 0;
      }
      const user = await tx.user.update({
        where: { id: recipientUserId },
        data: { undeliveredNotificationCount: { decrement: 1 } },
        select: { undeliveredNotificationCount: true },
      });
      return user.undeliveredNotificationCount;
    });
    this.presenceRealtime.emitNotificationsDeleted(recipientUserId, { notificationIds: [existing.id] });
    if (wasUndelivered) this.presenceRealtime.emitNotificationsUpdated(recipientUserId, { undeliveredCount });
  }

  /**
   * Create or overwrite repost notification for the original post author.
   * Grouped per (recipient, subject post): if a notification already exists
   * for this actor+post, update its timestamp to bubble it up without double-counting.
   */
  async upsertRepostNotification(params: {
    recipientUserId: string;
    actorUserId: string;
    subjectPostId: string;
    /** The repost/quote post itself — lets the recipient tap through to it. */
    actorPostId?: string;
    /** Defaults to 'reposted your post'. Pass 'quoted your post' for quote reposts. */
    title?: string;
  }) {
    const { recipientUserId, actorUserId, subjectPostId, actorPostId, title = 'reposted your post' } = params;
    const maxAttempts = 3;
    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      try {
        const res = await this.prisma.$transaction(
          async (tx) => {
            const existing = await tx.notification.findFirst({
              where: { recipientUserId, actorUserId, subjectPostId, kind: 'repost' },
              select: { id: true, deliveredAt: true },
            });

            if (existing) {
              await tx.notification.update({
                where: { id: existing.id },
                data: { createdAt: new Date(), title, ...(actorPostId ? { actorPostId } : {}) },
              });
              return { kind: 'updated' as const, notificationId: existing.id, undeliveredCount: null as number | null };
            }

            const notification = await tx.notification.create({
              data: {
                recipientUserId,
                kind: 'repost',
                actorUserId,
                subjectPostId,
                ...(actorPostId ? { actorPostId } : {}),
                title,
              },
              select: { id: true },
            });
            await tx.user.update({
              where: { id: recipientUserId },
              data: { undeliveredNotificationCount: { increment: 1 } },
            });
            const undeliveredCount = await tx.notification.count({
              where: { recipientUserId, deliveredAt: null },
            });
            return { kind: 'created' as const, notificationId: notification.id, undeliveredCount };
          },
          { isolationLevel: Prisma.TransactionIsolationLevel.Serializable },
        );

        if (res.kind === 'created' && typeof res.undeliveredCount === 'number') {
          this.presenceRealtime.emitNotificationsUpdated(recipientUserId, { undeliveredCount: res.undeliveredCount });
        }

        try {
          const dto = await this.query.buildNotificationDtoForRecipient({ recipientUserId, notificationId: res.notificationId });
          if (dto) this.presenceRealtime.emitNotificationNew(recipientUserId, { notification: dto });
        } catch { /* best-effort */ }

        // Web push for newly-created reposts (gated by pushRepost pref).
        // Updates (re-reposts of the same post) skip push to avoid re-notifying.
        if (res.kind === 'created') {
          void this.push.sendKindPushForActor({
            recipientUserId,
            kind: 'repost',
            actorUserId,
            fallbackTitle: title,
            body: null,
            subjectPostId: subjectPostId ?? null,
            subjectUserId: null,
            url: actorPostId ? `/p/${actorPostId}` : `/p/${subjectPostId}`,
          });
        }

        return;
      } catch (err: unknown) {
        const code = (err as any)?.code as string | undefined;
        const isRetryable = code === 'P2034' || /could not serialize access/i.test(String((err as any)?.message ?? err));
        if (attempt < maxAttempts && isRetryable) continue;
        throw err;
      }
    }
  }

  /** Remove repost notification when user un-reposts. */
  async deleteRepostNotification(
    recipientUserId: string,
    actorUserId: string,
    subjectPostId: string,
  ): Promise<void> {
    const existing = await this.prisma.notification.findFirst({
      where: { recipientUserId, actorUserId, subjectPostId, kind: 'repost' },
      select: { id: true, deliveredAt: true },
    });
    if (!existing) return;
    const wasUndelivered = existing.deliveredAt == null;
    const undeliveredCount = await this.prisma.$transaction(async (tx) => {
      await tx.notification.delete({ where: { id: existing.id } });
      if (!wasUndelivered) {
        const row = await tx.user.findUnique({ where: { id: recipientUserId }, select: { undeliveredNotificationCount: true } });
        return row?.undeliveredNotificationCount ?? 0;
      }
      const user = await tx.user.update({
        where: { id: recipientUserId },
        data: { undeliveredNotificationCount: { decrement: 1 } },
        select: { undeliveredNotificationCount: true },
      });
      return user.undeliveredNotificationCount;
    });
    this.presenceRealtime.emitNotificationsDeleted(recipientUserId, { notificationIds: [existing.id] });
    if (wasUndelivered) this.presenceRealtime.emitNotificationsUpdated(recipientUserId, { undeliveredCount });
  }

  private async deleteNotificationRowsAndEmit(
    rows: Array<{ id: string; recipientUserId: string; deliveredAt: Date | null; kind?: NotificationKind }>,
  ): Promise<number> {
    const ids = rows.map((r) => r.id).filter(Boolean);
    if (ids.length === 0) return 0;

    // `community_group_post` rows are bell-excluded: they never incremented
    // `undeliveredNotificationCount`, so deleting them must NOT decrement it
    // (that would drift the bell badge). They drive the Groups badge instead.
    const undeliveredDeletedByRecipient = new Map<string, number>();
    const groupBadgeRecipients = new Set<string>();
    for (const r of rows) {
      const uid = (r.recipientUserId ?? '').trim();
      if (!uid) continue;
      if (r.kind === 'community_group_post') {
        groupBadgeRecipients.add(uid);
        continue;
      }
      if (r.deliveredAt != null) continue;
      undeliveredDeletedByRecipient.set(uid, (undeliveredDeletedByRecipient.get(uid) ?? 0) + 1);
    }

    const updatedCountByRecipient = await this.prisma.$transaction(async (tx) => {
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
      return updates;
    });

    const idsByRecipient = new Map<string, string[]>();
    for (const r of rows) {
      const uid = (r.recipientUserId ?? '').trim();
      if (!uid) continue;
      const list = idsByRecipient.get(uid) ?? [];
      list.push(r.id);
      idsByRecipient.set(uid, list);
    }

    for (const [uid, notifIds] of idsByRecipient) {
      this.presenceRealtime.emitNotificationsDeleted(uid, { notificationIds: notifIds });
    }

    for (const [uid, undeliveredCount] of updatedCountByRecipient) {
      this.presenceRealtime.emitNotificationsUpdated(uid, { undeliveredCount });
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
    const id = (subjectPostId ?? '').trim();
    if (!id) return 0;
    const rows = await this.prisma.notification.findMany({
      where: { subjectPostId: id },
      select: { id: true, recipientUserId: true, deliveredAt: true, kind: true },
    });
    return await this.deleteNotificationRowsAndEmit(rows);
  }

  /** Delete all notifications caused by this post (e.g. replies or mentions) using actorPostId. */
  async deleteByActorPostId(actorPostId: string): Promise<number> {
    const id = (actorPostId ?? '').trim();
    if (!id) return 0;
    const rows = await this.prisma.notification.findMany({
      where: { actorPostId: id },
      select: { id: true, recipientUserId: true, deliveredAt: true, kind: true },
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
    const crewId = (params.crewId ?? '').trim();
    const actorUserId = (params.actorUserId ?? '').trim();
    if (!crewId || !actorUserId) return 0;
    const rows = await this.prisma.notification.findMany({
      where: {
        subjectCrewId: crewId,
        actorUserId,
        kind: { in: ['crew_member_joined', 'crew_invite_accepted'] },
      },
      select: { id: true, recipientUserId: true, deliveredAt: true },
    });
    return await this.deleteNotificationRowsAndEmit(rows);
  }

  /** Delete follow notifications for a relationship (used on unfollow). */
  async deleteFollowNotification(recipientUserId: string, actorUserId: string): Promise<number> {
    const recipient = (recipientUserId ?? '').trim();
    const actor = (actorUserId ?? '').trim();
    if (!recipient || !actor) return 0;
    const rows = await this.prisma.notification.findMany({
      where: { recipientUserId: recipient, actorUserId: actor, kind: 'follow' },
      select: { id: true, recipientUserId: true, deliveredAt: true },
    });
    return await this.deleteNotificationRowsAndEmit(rows);
  }

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
    const { inviteeUserId, inviterUserId, groupId, inviteId, bodySnippet } = params;
    if (inviteeUserId === inviterUserId) return { notified: false };

    const result = await this.prisma.$transaction(async (tx) => {
      const existing = await tx.notification.findFirst({
        where: {
          recipientUserId: inviteeUserId,
          kind: 'community_group_invite_received',
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
          },
        });
        if (wasDelivered) {
          await tx.user.update({
            where: { id: inviteeUserId },
            data: { undeliveredNotificationCount: { increment: 1 } },
          });
        }
        const undeliveredCount = await tx.notification.count({
          where: { recipientUserId: inviteeUserId, deliveredAt: null },
        });
        return { kind: 'updated' as const, notificationId: existing.id, undeliveredCount };
      }

      const created = await tx.notification.create({
        data: {
          recipientUserId: inviteeUserId,
          kind: 'community_group_invite_received',
          actorUserId: inviterUserId,
          subjectGroupId: groupId,
          subjectCommunityGroupInviteId: inviteId,
          title: 'invited you to their group',
          body: bodySnippet ?? undefined,
        },
        select: { id: true },
      });
      await tx.user.update({
        where: { id: inviteeUserId },
        data: { undeliveredNotificationCount: { increment: 1 } },
      });
      const undeliveredCount = await tx.notification.count({
        where: { recipientUserId: inviteeUserId, deliveredAt: null },
      });
      return { kind: 'created' as const, notificationId: created.id, undeliveredCount };
    });

    this.presenceRealtime.emitNotificationsUpdated(inviteeUserId, {
      undeliveredCount: result.undeliveredCount,
    });
    try {
      const dto = await this.query.buildNotificationDtoForRecipient({
        recipientUserId: inviteeUserId,
        notificationId: result.notificationId,
      });
      if (dto) {
        this.presenceRealtime.emitNotificationNew(inviteeUserId, { notification: dto });
      }
    } catch (err) {
      this.logger.debug(`[notifications] Failed to emit group invite notification: ${err}`);
    }

    // Web push (best-effort, gated on user prefs).
    void this.push.sendKindPushForActor({
      recipientUserId: inviteeUserId,
      kind: 'community_group_invite_received',
      actorUserId: inviterUserId,
      fallbackTitle: 'invited you to their group',
      body: bodySnippet ?? null,
      subjectPostId: null,
      subjectUserId: null,
      sourceLabel: 'From notifications',
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
    response: 'accepted' | 'declined';
  }): Promise<void> {
    const { inviterUserId, inviteeUserId, groupId, inviteId, response } = params;
    if (inviterUserId === inviteeUserId) return;
    const kind: NotificationKind =
      response === 'accepted'
        ? 'community_group_invite_accepted'
        : 'community_group_invite_declined';

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
          data: { createdAt: now, deliveredAt: null, readAt: null, ignoredAt: null },
        });
        if (wasDelivered) {
          await tx.user.update({
            where: { id: inviterUserId },
            data: { undeliveredNotificationCount: { increment: 1 } },
          });
        }
        const undeliveredCount = await tx.notification.count({
          where: { recipientUserId: inviterUserId, deliveredAt: null },
        });
        return { kind: 'updated' as const, notificationId: existing.id, undeliveredCount };
      }
      const created = await tx.notification.create({
        data: {
          recipientUserId: inviterUserId,
          kind,
          actorUserId: inviteeUserId,
          subjectGroupId: groupId,
          subjectCommunityGroupInviteId: inviteId,
          title:
            response === 'accepted'
              ? 'accepted your group invite'
              : 'declined your group invite',
        },
        select: { id: true },
      });
      await tx.user.update({
        where: { id: inviterUserId },
        data: { undeliveredNotificationCount: { increment: 1 } },
      });
      const undeliveredCount = await tx.notification.count({
        where: { recipientUserId: inviterUserId, deliveredAt: null },
      });
      return { kind: 'created' as const, notificationId: created.id, undeliveredCount };
    });

    this.presenceRealtime.emitNotificationsUpdated(inviterUserId, {
      undeliveredCount: result.undeliveredCount,
    });
    try {
      const dto = await this.query.buildNotificationDtoForRecipient({
        recipientUserId: inviterUserId,
        notificationId: result.notificationId,
      });
      if (dto) {
        this.presenceRealtime.emitNotificationNew(inviterUserId, { notification: dto });
      }
    } catch (err) {
      this.logger.debug(`[notifications] Failed to emit invite response notification: ${err}`);
    }

    // Push for accepted/declined is best-effort; reuse generic flow.
    void this.push.sendKindPushForActor({
      recipientUserId: inviterUserId,
      kind,
      actorUserId: inviteeUserId,
      fallbackTitle: null,
      body: null,
      subjectPostId: null,
      subjectUserId: null,
      sourceLabel: 'From notifications',
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
  }): Promise<{ notificationId: string; undeliveredCount: number; isNew: boolean }> {
    const { recipientUserId, kind, actorUserId, subjectGroupId, title } = params;
    return this.prisma.$transaction(async (tx) => {
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
          data: { createdAt: new Date(), deliveredAt: null, readAt: null, ignoredAt: null, title },
        });
        if (wasDelivered) {
          await tx.user.update({
            where: { id: recipientUserId },
            data: { undeliveredNotificationCount: { increment: 1 } },
          });
        }
        const undeliveredCount = await tx.notification.count({
          where: { recipientUserId, deliveredAt: null },
        });
        return { notificationId: existing.id, undeliveredCount, isNew: false };
      }

      const created = await tx.notification.create({
        data: { recipientUserId, kind, actorUserId: actorUserId ?? undefined, subjectGroupId, title },
        select: { id: true },
      });
      await tx.user.update({
        where: { id: recipientUserId },
        data: { undeliveredNotificationCount: { increment: 1 } },
      });
      const undeliveredCount = await tx.notification.count({
        where: { recipientUserId, deliveredAt: null },
      });
      return { notificationId: created.id, undeliveredCount, isNew: true };
    }, { isolationLevel: Prisma.TransactionIsolationLevel.Serializable });
  }

  private async emitGroupNotification(recipientUserId: string, notificationId: string, undeliveredCount: number) {
    this.presenceRealtime.emitNotificationsUpdated(recipientUserId, { undeliveredCount });
    try {
      const dto = await this.query.buildNotificationDtoForRecipient({ recipientUserId, notificationId });
      if (dto) this.presenceRealtime.emitNotificationNew(recipientUserId, { notification: dto });
    } catch { /* best-effort */ }
  }

  private async pushGroupNotification(params: {
    recipientUserId: string;
    actorUserId: string | null;
    kind: NotificationKind;
    subjectGroupId: string;
  }): Promise<void> {
    const { recipientUserId, actorUserId, kind, subjectGroupId } = params;
    const group = await this.prisma.communityGroup?.findUnique({
      where: { id: subjectGroupId },
      select: { slug: true },
    });
    void this.push.sendKindPushForActor({
      recipientUserId,
      kind,
      actorUserId,
      fallbackTitle: null,
      body: null,
      subjectPostId: null,
      subjectUserId: null,
      url: `/g/${group?.slug ?? subjectGroupId}`,
      sourceLabel: 'From notifications',
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
      kind: 'community_group_member_joined',
      actorUserId: joinerUserId,
      subjectGroupId: groupId,
      title: 'joined the group',
    });
    await this.emitGroupNotification(recipientUserId, result.notificationId, result.undeliveredCount);
    if (result.isNew) {
      void this.pushGroupNotification({
        recipientUserId,
        actorUserId: joinerUserId,
        kind: 'community_group_member_joined',
        subjectGroupId: groupId,
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
    decision: 'approved' | 'rejected';
  }): Promise<void> {
    const { recipientUserId, groupId, actorUserId, decision } = params;
    if (recipientUserId === actorUserId) return;
    const kind: NotificationKind = decision === 'approved' ? 'community_group_join_approved' : 'community_group_join_rejected';
    const title = decision === 'approved' ? 'Your join request was approved' : 'Your join request was not accepted';
    const result = await this.upsertGroupNotification({
      recipientUserId,
      kind,
      actorUserId,
      subjectGroupId: groupId,
      title,
    });
    await this.emitGroupNotification(recipientUserId, result.notificationId, result.undeliveredCount);
    if (result.isNew) {
      void this.pushGroupNotification({ recipientUserId, actorUserId, kind, subjectGroupId: groupId });
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
      kind: 'community_group_member_removed',
      actorUserId,
      subjectGroupId: groupId,
      title: 'You were removed from a group',
    });
    await this.emitGroupNotification(recipientUserId, result.notificationId, result.undeliveredCount);
    if (result.isNew) {
      void this.pushGroupNotification({
        recipientUserId,
        actorUserId,
        kind: 'community_group_member_removed',
        subjectGroupId: groupId,
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
      kind: 'community_group_disbanded',
      actorUserId,
      subjectGroupId: groupId,
      title: 'A group you were in was disbanded',
    });
    await this.emitGroupNotification(recipientUserId, result.notificationId, result.undeliveredCount);
    if (result.isNew) {
      void this.pushGroupNotification({
        recipientUserId,
        actorUserId,
        kind: 'community_group_disbanded',
        subjectGroupId: groupId,
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
  }): Promise<{ notificationId: string; undeliveredCount: number; isNew: boolean }> {
    const { recipientUserId, kind, actorUserId, subjectCrewId, title } = params;
    return this.prisma.$transaction(async (tx) => {
      const existing = await tx.notification.findFirst({
        where: { recipientUserId, kind, actorUserId: actorUserId ?? undefined, subjectCrewId },
        select: { id: true, deliveredAt: true },
      });

      if (existing) {
        const wasDelivered = existing.deliveredAt != null;
        await tx.notification.update({
          where: { id: existing.id },
          data: { createdAt: new Date(), deliveredAt: null, readAt: null, ignoredAt: null, title },
        });
        if (wasDelivered) {
          await tx.user.update({
            where: { id: recipientUserId },
            data: { undeliveredNotificationCount: { increment: 1 } },
          });
        }
        const undeliveredCount = await tx.notification.count({ where: { recipientUserId, deliveredAt: null } });
        return { notificationId: existing.id, undeliveredCount, isNew: false };
      }

      const created = await tx.notification.create({
        data: { recipientUserId, kind, actorUserId: actorUserId ?? undefined, subjectCrewId, title },
        select: { id: true },
      });
      await tx.user.update({
        where: { id: recipientUserId },
        data: { undeliveredNotificationCount: { increment: 1 } },
      });
      const undeliveredCount = await tx.notification.count({ where: { recipientUserId, deliveredAt: null } });
      return { notificationId: created.id, undeliveredCount, isNew: true };
    }, { isolationLevel: Prisma.TransactionIsolationLevel.Serializable });
  }

  private async emitCrewNotification(recipientUserId: string, notificationId: string, undeliveredCount: number) {
    this.presenceRealtime.emitNotificationsUpdated(recipientUserId, { undeliveredCount });
    try {
      const dto = await this.query.buildNotificationDtoForRecipient({ recipientUserId, notificationId });
      if (dto) this.presenceRealtime.emitNotificationNew(recipientUserId, { notification: dto });
    } catch { /* best-effort */ }
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
      kind: 'crew_member_left',
      actorUserId: leaverUserId,
      subjectCrewId: crewId,
      title: 'left your crew',
    });
    await this.emitCrewNotification(recipientUserId, result.notificationId, result.undeliveredCount);
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
      kind: 'crew_member_kicked',
      actorUserId,
      subjectCrewId: crewId,
      title: 'You were removed from your crew',
    });
    await this.emitCrewNotification(recipientUserId, result.notificationId, result.undeliveredCount);
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
      kind: 'crew_disbanded',
      actorUserId,
      subjectCrewId: crewId,
      title: 'Your crew was disbanded',
    });
    await this.emitCrewNotification(recipientUserId, result.notificationId, result.undeliveredCount);
  }

  /**
   * Bulk-create badge-only `community_group_post` notification rows for a new top-level
   * group post. These rows drive the Groups nav badge and per-group card badges — they are
   * intentionally excluded from the main notification bell + feed.
   *
   * Does NOT increment `undeliveredNotificationCount` (those are bell-only) and does NOT
   * emit `notifications:new` or `notifications:updated`. Emits `groups:unreadChanged`
   * per recipient so badges update in real time.
   */
  async createGroupPostBadgeNotifications(params: {
    actorUserId: string;
    postId: string;
    groupId: string;
    recipientUserIds: string[];
  }): Promise<void> {
    const { actorUserId, postId, groupId, recipientUserIds } = params;
    const now = new Date();
    const toCreate = recipientUserIds.filter((id) => id && id !== actorUserId);
    if (toCreate.length === 0) return;

    await this.prisma.notification.createMany({
      data: toCreate.map((recipientUserId) => ({
        recipientUserId,
        kind: 'community_group_post' as const,
        actorUserId,
        subjectPostId: postId,
        subjectGroupId: groupId,
        createdAt: now,
      })),
      skipDuplicates: true,
    });

    // Emit groups:unreadChanged per recipient (best-effort, fire-and-forget).
    for (const recipientUserId of toCreate) {
      void this.readState.emitGroupsUnreadForUser(recipientUserId);
    }
  }

  /**
   * Notify a user that they mentioned @marv in a group where he is not a member,
   * so he will not respond. Rate-limited to once per hour per (user, group) pair
   * to avoid spam if someone mentions @marv repeatedly.
   *
   * - actorUserId = Marv (drives his avatar on the notification row)
   * - actorPostId = the post that triggered the mention (tap target)
   * - subjectGroupId = the group
   */
  async upsertMarvNotInGroupNotification(params: {
    recipientUserId: string;
    marvUserId: string;
    postId: string;
    groupId: string;
  }): Promise<void> {
    const { recipientUserId, marvUserId, postId, groupId } = params;

    // Rate-limit: skip if we already sent this notification for this user + group within the last hour.
    const oneHourAgo = new Date(Date.now() - 60 * 60 * 1000);
    const recent = await this.prisma.notification.findFirst({
      where: {
        recipientUserId,
        kind: 'marv_not_in_group',
        subjectGroupId: groupId,
        createdAt: { gte: oneHourAgo },
      },
      select: { id: true },
    });
    if (recent) return;

    await this.create({
      recipientUserId,
      kind: 'marv_not_in_group',
      actorUserId: marvUserId,
      actorPostId: postId,
      subjectGroupId: groupId,
      body: "@marv is not in this group, so he won't respond. Ask an owner to add him!",
    });
  }
}
