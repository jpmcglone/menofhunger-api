import { Injectable, Logger } from '@nestjs/common';
import { Prisma, type NotificationKind } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { PresenceRealtimeService } from '../presence/presence-realtime.service';
import { PresenceRedisStateService } from '../presence/presence-redis-state.service';
import { JobsService } from '../jobs/jobs.service';
import { JOBS } from '../jobs/jobs.constants';
import { chunk, FANOUT_CONCURRENCY, runInBatches } from '../side-effects/batch';
import { FANOUT_CHUNK_SIZE } from '../side-effects/side-effects.constants';
import { SideEffectsService } from '../side-effects/side-effects.service';
import { NotificationQueryService } from './notification-query.service';
import { isBellCountedNotificationKind, NotificationReadStateService } from './notification-read-state.service';
import { CacheInvalidationService } from '../redis/cache-invalidation.service';

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
  subjectSpaceId?: string | null;
  title?: string | null;
  body?: string | null;
};

/**
 * Notification row writes: create + the upsert families (boost, repost, group
 * invites, group/crew lifecycle) and bulk deletes. Owns the post-write fan-out
 * (badge emit, `notifications:new` payload emit, instant email) and dispatches
 * the push itself to the side-effects queue so it retries independently.
 */
@Injectable()
export class NotificationWriterService {
  private readonly logger = new Logger(NotificationWriterService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly presenceRealtime: PresenceRealtimeService,
    private readonly presenceRedis: PresenceRedisStateService,
    private readonly jobs: JobsService,
    private readonly sideEffects: SideEffectsService,
    private readonly query: NotificationQueryService,
    private readonly readState: NotificationReadStateService,
    private readonly cacheInvalidation?: CacheInvalidationService,
  ) {}

  private emitBellAndInvalidateList(
    recipientUserId: string,
    payload: { undeliveredCount: number },
  ): void {
    void this.cacheInvalidation?.bumpNotificationsList(recipientUserId);
    this.presenceRealtime.emitNotificationsUpdated(recipientUserId, payload);
  }

  /**
   * Returns the current timestamp when the recipient is actively present
   * (online and not idle, checked cross-instance via Redis), or null otherwise.
   * Used to stamp `presentAt` on new notifications so email crons can skip them —
   * the user already saw the realtime event live, so an email is redundant.
   * Never throws; presence is best-effort and must never block notification creation.
   */
  private async presentAtForRecipient(userId: string): Promise<Date | null> {
    try {
      const online = await this.presenceRedis.isOnline(userId);
      if (!online) return null;
      const idle = await this.presenceRedis.isIdle(userId);
      return idle ? null : new Date();
    } catch {
      return null;
    }
  }

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
      subjectSpaceId,
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
        comment: 'replied to your post',
        nudge: 'nudged you',
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
        status_update: 'updated their status',
        checkin_post: 'checked in',
        account_verified: "You're verified",
        premium_started: "You're Premium",
        premium_ended: 'Your Premium ended',
        space_reminder_day: 'Space today',
        space_reminder_soon: 'Space starting soon',
        space_live: 'Space is live',
        space_schedule_cancelled: 'Space cancelled',
        space_schedule_rescheduled: 'Space rescheduled',
      } as Partial<Record<NotificationKind, string>>)[kind] ??
      null;

    // Resolve presence before the transaction so the Redis call doesn't extend it.
    const presentAt = await this.presentAtForRecipient(recipientUserId);

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
          subjectSpaceId: subjectSpaceId ?? undefined,
          title: fallbackTitle ?? undefined,
          body: body ?? undefined,
          presentAt: presentAt ?? undefined,
        },
      });
      // Message and community-group-post rows have dedicated badges and must not
      // affect the denormalized notification-bell counter.
      if (isBellCountedNotificationKind(kind)) {
        await tx.user.update({
          where: { id: recipientUserId },
          data: { undeliveredNotificationCount: { increment: 1 } },
        });
      }
      const undeliveredCount = await tx.notification.count({
        where: this.readState.undeliveredBellWhere(recipientUserId),
      });
      return { notification, undeliveredCount };
    });

    this.emitBellAndInvalidateList(recipientUserId, {
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
    let pushUrl: string | null =
      subjectArticleId && (
        kind === 'comment' || kind === 'mention' || kind === 'followed_article' || kind === 'boost'
      )
        ? `/a/${subjectArticleId}${commentHash}`
        : kind === 'comment' && actorPostId
          ? `/p/${actorPostId}`
          : kind === 'mention' && actorPostId
            ? `/p/${actorPostId}`
            : (kind === 'followed_post' || kind === 'checkin_post') && subjectPostId
              ? `/p/${subjectPostId}`
            : kind === 'boost' && subjectPostId
              ? `/p/${subjectPostId}`
              : kind === 'coin_transfer'
                ? '/coins'
                : null;

    if (
      !pushUrl &&
      subjectSpaceId &&
      (kind === 'space_reminder_day' ||
        kind === 'space_reminder_soon' ||
        kind === 'space_live' ||
        kind === 'space_schedule_cancelled' ||
        kind === 'space_schedule_rescheduled')
    ) {
      const space = await this.prisma.space.findUnique({
        where: { id: subjectSpaceId },
        select: { owner: { select: { username: true } } },
      });
      const username = (space?.owner?.username ?? '').trim();
      if (username) pushUrl = `/s/${encodeURIComponent(username)}`;
    }
    // Intentionally omit sourceLabel for actor-driven pushes: the actor's words
    // (snippet) are the most valuable byte budget. sourceLabel is reserved for
    // system-originated pushes (streak reminders, daily prompt, message channel).
    this.sideEffects.dispatch('notification.push', {
      recipientUserId,
      kind,
      actorUserId: actorUserId ?? null,
      fallbackTitle,
      body,
      actorPostId: actorPostId ?? null,
      subjectArticleId: subjectArticleId ?? null,
      subjectPostId: subjectPostId ?? null,
      subjectUserId: subjectUserId ?? null,
      subjectGroupId: subjectGroupId ?? null,
      subjectCommunityGroupInviteId: subjectCommunityGroupInviteId ?? null,
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
    subjectPostKind?: string | null;
  }) {
    const { recipientUserId, actorUserId, subjectPostId, bodySnippet, subjectPostKind } = params;
    // Never notify a user about their own boost.
    if (actorUserId && actorUserId === recipientUserId) return;
    const boostTitle =
      subjectPostKind === 'status' ? 'boosted your status' : 'boosted your post';
    const maxAttempts = 3;
    // Resolve presence before the transaction so the Redis call doesn't extend it.
    const presentAt = await this.presentAtForRecipient(recipientUserId);
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
                data: {
                  createdAt: new Date(),
                  body: bodySnippet ?? undefined,
                  title: boostTitle,
                },
              });
              return { kind: 'updated' as const, notificationId: existing.id, undeliveredCount: null as number | null };
            }

            const notification = await tx.notification.create({
              data: {
                recipientUserId,
                kind: 'boost',
                actorUserId,
                subjectPostId,
                title: boostTitle,
                body: bodySnippet ?? undefined,
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
            return {
              kind: 'created' as const,
              notificationId: notification.id,
              undeliveredCount,
            };
          },
          { isolationLevel: Prisma.TransactionIsolationLevel.Serializable },
        );

        if (res.kind === 'created' && typeof res.undeliveredCount === 'number') {
          this.emitBellAndInvalidateList(recipientUserId, { undeliveredCount: res.undeliveredCount });
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
          this.sideEffects.dispatch('notification.push', {
            recipientUserId,
            kind: 'boost',
            actorUserId,
            fallbackTitle: boostTitle,
            body: bodySnippet ?? null,
            actorPostId: null,
            subjectPostId: subjectPostId ?? null,
            subjectUserId: null,
            notificationId: res.notificationId,
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
    if (wasUndelivered) this.emitBellAndInvalidateList(recipientUserId, { undeliveredCount });
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
    // Never notify a user about their own repost/quote.
    if (actorUserId && actorUserId === recipientUserId) return;
    const isQuote = title === 'quoted your post';
    const maxAttempts = 3;
    // Resolve presence before the transaction so the Redis call doesn't extend it.
    const presentAt = await this.presentAtForRecipient(recipientUserId);
    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      try {
        const res = await this.prisma.$transaction(
          async (tx) => {
            // Quote reposts are keyed by actorPostId (each quoting post → its own row).
            // Flat reposts are keyed by (actorUserId, subjectPostId) — one per user per post.
            const existing = await tx.notification.findFirst({
              where: isQuote && actorPostId
                ? { actorPostId, kind: 'repost' }
                : { recipientUserId, actorUserId, subjectPostId, kind: 'repost' },
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
            return { kind: 'created' as const, notificationId: notification.id, undeliveredCount };
          },
          { isolationLevel: Prisma.TransactionIsolationLevel.Serializable },
        );

        if (res.kind === 'created' && typeof res.undeliveredCount === 'number') {
          this.emitBellAndInvalidateList(recipientUserId, { undeliveredCount: res.undeliveredCount });
        }

        try {
          const dto = await this.query.buildNotificationDtoForRecipient({ recipientUserId, notificationId: res.notificationId });
          if (dto) this.presenceRealtime.emitNotificationNew(recipientUserId, { notification: dto });
        } catch { /* best-effort */ }

        // Web push for newly-created reposts (gated by pushRepost pref).
        // Updates (re-reposts of the same post) skip push to avoid re-notifying.
        if (res.kind === 'created') {
          this.sideEffects.dispatch('notification.push', {
            recipientUserId,
            kind: 'repost',
            actorUserId,
            fallbackTitle: title,
            body: null,
            actorPostId: actorPostId ?? null,
            subjectPostId: subjectPostId ?? null,
            subjectUserId: null,
            url: actorPostId ? `/p/${actorPostId}` : `/p/${subjectPostId}`,
            notificationId: res.notificationId,
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
    if (wasUndelivered) this.emitBellAndInvalidateList(recipientUserId, { undeliveredCount });
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
    const undeliveredGroupDeletedByRecipient = new Map<string, number>();
    const groupBadgeRecipients = new Set<string>();
    for (const r of rows) {
      const uid = (r.recipientUserId ?? '').trim();
      if (!uid) continue;
      if (r.kind === 'community_group_post') {
        groupBadgeRecipients.add(uid);
        if (r.deliveredAt == null) {
          undeliveredGroupDeletedByRecipient.set(uid, (undeliveredGroupDeletedByRecipient.get(uid) ?? 0) + 1);
        }
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
      for (const [uid, delta] of undeliveredGroupDeletedByRecipient) {
        if (delta <= 0) continue;
        await tx.user.update({
          where: { id: uid },
          data: { undeliveredGroupPostCount: { decrement: delta } },
        });
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
      this.emitBellAndInvalidateList(uid, { undeliveredCount });
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

    // Resolve presence before the transaction so the Redis call doesn't extend it.
    const presentAt = await this.presentAtForRecipient(inviteeUserId);

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
      return { kind: 'created' as const, notificationId: created.id, undeliveredCount };
    });

    this.emitBellAndInvalidateList(inviteeUserId, {
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
    this.sideEffects.dispatch('notification.push', {
      recipientUserId: inviteeUserId,
      kind: 'community_group_invite_received',
      actorUserId: inviterUserId,
      fallbackTitle: 'invited you to their group',
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
    response: 'accepted' | 'declined';
  }): Promise<void> {
    const { inviterUserId, inviteeUserId, groupId, inviteId, response } = params;
    if (inviterUserId === inviteeUserId) return;
    const kind: NotificationKind =
      response === 'accepted'
        ? 'community_group_invite_accepted'
        : 'community_group_invite_declined';

    // Resolve presence before the transaction so the Redis call doesn't extend it.
    const presentAt = await this.presentAtForRecipient(inviterUserId);

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
          data: { createdAt: now, deliveredAt: null, readAt: null, ignoredAt: null, presentAt: presentAt ?? null },
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
      return { kind: 'created' as const, notificationId: created.id, undeliveredCount };
    });

    this.emitBellAndInvalidateList(inviterUserId, {
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
    this.sideEffects.dispatch('notification.push', {
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
  }): Promise<{ notificationId: string; undeliveredCount: number; isNew: boolean }> {
    const { recipientUserId, kind, actorUserId, subjectGroupId, title } = params;
    // Resolve presence before the transaction so the Redis call doesn't extend it.
    const presentAt = await this.presentAtForRecipient(recipientUserId);
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
          data: { createdAt: new Date(), deliveredAt: null, readAt: null, ignoredAt: null, title, presentAt: presentAt ?? null },
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
        return { notificationId: existing.id, undeliveredCount, isNew: false };
      }

      const created = await tx.notification.create({
        data: { recipientUserId, kind, actorUserId: actorUserId ?? undefined, subjectGroupId, title, presentAt: presentAt ?? undefined },
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
    }, { isolationLevel: Prisma.TransactionIsolationLevel.Serializable });
  }

  private async emitGroupNotification(recipientUserId: string, notificationId: string, undeliveredCount: number) {
    this.emitBellAndInvalidateList(recipientUserId, { undeliveredCount });
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
    notificationId: string;
  }): Promise<void> {
    const { recipientUserId, actorUserId, kind, subjectGroupId, notificationId } = params;
    this.sideEffects.dispatch('notification.push', {
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
  }): Promise<{ notificationId: string; undeliveredCount: number; isNew: boolean }> {
    const { recipientUserId, kind, actorUserId, subjectCrewId, title } = params;
    // Resolve presence before the transaction so the Redis call doesn't extend it.
    const presentAt = await this.presentAtForRecipient(recipientUserId);
    return this.prisma.$transaction(async (tx) => {
      const existing = await tx.notification.findFirst({
        where: { recipientUserId, kind, actorUserId: actorUserId ?? undefined, subjectCrewId },
        select: { id: true, deliveredAt: true },
      });

      if (existing) {
        const wasDelivered = existing.deliveredAt != null;
        await tx.notification.update({
          where: { id: existing.id },
          data: { createdAt: new Date(), deliveredAt: null, readAt: null, ignoredAt: null, title, presentAt: presentAt ?? null },
        });
        if (wasDelivered) {
          await tx.user.update({
            where: { id: recipientUserId },
            data: { undeliveredNotificationCount: { increment: 1 } },
          });
        }
        const undeliveredCount = await tx.notification.count({ where: this.readState.undeliveredBellWhere(recipientUserId) });
        return { notificationId: existing.id, undeliveredCount, isNew: false };
      }

      const created = await tx.notification.create({
        data: { recipientUserId, kind, actorUserId: actorUserId ?? undefined, subjectCrewId, title, presentAt: presentAt ?? undefined },
        select: { id: true },
      });
      await tx.user.update({
        where: { id: recipientUserId },
        data: { undeliveredNotificationCount: { increment: 1 } },
      });
      const undeliveredCount = await tx.notification.count({ where: this.readState.undeliveredBellWhere(recipientUserId) });
      return { notificationId: created.id, undeliveredCount, isNew: true };
    }, { isolationLevel: Prisma.TransactionIsolationLevel.Serializable });
  }

  private async emitCrewNotification(recipientUserId: string, notificationId: string, undeliveredCount: number) {
    this.emitBellAndInvalidateList(recipientUserId, { undeliveredCount });
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
    const { actorUserId, postId, groupId, recipientUserIds, groupName, bodySnippet } = params;
    const now = new Date();
    const toCreate = recipientUserIds.filter((id) => id && id !== actorUserId);
    if (toCreate.length === 0) return;

    // Chunked so a very large group doesn't become one enormous INSERT that holds a
    // connection (and its locks) for seconds.
    for (const slice of chunk(toCreate, FANOUT_CHUNK_SIZE)) {
      await this.prisma.notification.createMany({
        data: slice.map((recipientUserId) => ({
          recipientUserId,
          kind: 'community_group_post' as const,
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

    // Each badge emit is its own count query, so this is bounded rather than one promise
    // per recipient.
    await runInBatches(toCreate, FANOUT_CONCURRENCY, async (recipientUserId) => {
      await this.readState.emitGroupsUnreadForUser(recipientUserId);
    });
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

    const group = await this.prisma.communityGroup.findUnique({
      where: { id: groupId },
      select: { name: true },
    });
    const groupName = group?.name?.trim() || null;
    const groupLabel = groupName ? `**${groupName}**` : 'this group';

    await this.create({
      recipientUserId,
      kind: 'marv_not_in_group',
      actorUserId: marvUserId,
      actorPostId: postId,
      subjectGroupId: groupId,
      body: `@marv is not in ${groupLabel}, so he won't respond. Ask an owner to add him!`,
    });
  }

  /**
   * Fan-out a status_update notification to all followers of the actor.
   *
   * `mode: 'created'` — a new status: write a NEW notification row per follower (bell + push).
   * `mode: 'edited'` — the active status was reworded: patch each follower's latest row in
   * place (no new row, no bell, no push).
   *
   * Fetches the actor's username once for the push URL, then writes per follower with
   * bounded concurrency — one promise per follower would open thousands of transactions at
   * once for a popular account.
   */
  async fanOutStatusUpdateNotifications(params: {
    actorUserId: string;
    text: string;
    postId: string | null;
    mode: 'created' | 'edited';
  }): Promise<void> {
    const { actorUserId, text, postId, mode } = params;

    const [actor, follows] = await Promise.all([
      this.prisma.user.findUnique({
        where: { id: actorUserId },
        select: { username: true },
      }),
      this.prisma.follow.findMany({
        where: { followingId: actorUserId },
        select: { followerId: true },
      }),
    ]);

    if (!actor || follows.length === 0) return;
    const actorUsername = actor.username ?? '';

    const recipientIds = follows
      .map((f) => f.followerId)
      .filter((id) => id && id !== actorUserId);

    const result = await runInBatches(recipientIds, FANOUT_CONCURRENCY, async (recipientUserId) => {
      const args = { recipientUserId, actorUserId, actorUsername, text, postId };
      await (mode === 'created'
        ? this.createStatusUpdateNotification(args)
        : this.patchStatusUpdateNotification(args));
    });

    if (result.failed > 0) {
      this.logger.warn(
        `[notifications] status_update fan-out: ${result.failed}/${recipientIds.length} writes failed.`,
      );
    }
  }

  /**
   * Create a NEW status_update notification row for one recipient.
   *
   * Every new status is its own event, so it gets its own row pointing at that status's
   * post (or the actor's profile when the status made no post). Older status notifications
   * are left intact as history. Increments the bell and sends a push.
   */
  async createStatusUpdateNotification(params: {
    recipientUserId: string;
    actorUserId: string;
    actorUsername: string;
    text: string;
    postId: string | null;
  }): Promise<void> {
    const { recipientUserId, actorUserId, actorUsername, text, postId } = params;
    if (actorUserId === recipientUserId) return;

    const maxAttempts = 3;
    const presentAt = await this.presentAtForRecipient(recipientUserId);

    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      try {
        const res = await this.prisma.$transaction(
          async (tx) => {
            const notification = await tx.notification.create({
              data: {
                recipientUserId,
                kind: 'status_update',
                actorUserId,
                subjectUserId: actorUserId,
                subjectPostId: postId ?? undefined,
                title: 'updated their status',
                body: text,
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

            return { notificationId: notification.id, undeliveredCount };
          },
          { isolationLevel: Prisma.TransactionIsolationLevel.Serializable },
        );

        this.emitBellAndInvalidateList(recipientUserId, {
          undeliveredCount: res.undeliveredCount,
        });

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

        // Deliberately no subjectPostId: buildPushTag prefers it over subjectUserId, which
        // would give every status its own coalesce tag and let a burst of statuses buzz the
        // follower once each. Keeping the tag actor-scoped means the in-app rows stay
        // one-per-status while pushes collapse inside the status_update coalesce window.
        // The deep link is passed explicitly via `url` instead.
        this.sideEffects.dispatch('notification.push', {
          recipientUserId,
          kind: 'status_update',
          actorUserId,
          fallbackTitle: 'updated their status',
          body: text,
          subjectUserId: actorUserId,
          url: postId ? `/p/${postId}` : `/u/${actorUsername}`,
          notificationId: res.notificationId,
        });

        return;
      } catch (err) {
        if (
          err instanceof Prisma.PrismaClientKnownRequestError &&
          (err.code === 'P2034' || err.code === 'P2002') &&
          attempt < maxAttempts
        ) {
          continue;
        }
        throw err;
      }
    }
  }

  /**
   * Patch the most recent status_update notification for one recipient in place.
   *
   * Used when the actor edits the text of their active status: the notification already
   * exists and already points at the right post, so we only refresh the body. No new row,
   * no bell increment, no push — just a `silent` notifications:new emit so open clients
   * repaint the text without a sound or badge change.
   */
  async patchStatusUpdateNotification(params: {
    recipientUserId: string;
    actorUserId: string;
    text: string;
    postId: string | null;
  }): Promise<void> {
    const { recipientUserId, actorUserId, text, postId } = params;
    if (actorUserId === recipientUserId) return;

    const existing = await this.prisma.notification.findFirst({
      where: { recipientUserId, actorUserId, kind: 'status_update' },
      orderBy: { createdAt: 'desc' },
      select: { id: true },
    });
    if (!existing) return;

    await this.prisma.notification.update({
      where: { id: existing.id },
      data: { body: text, subjectPostId: postId ?? undefined },
    });

    try {
      const dto = await this.query.buildNotificationDtoForRecipient({
        recipientUserId,
        notificationId: existing.id,
      });
      if (dto) {
        this.presenceRealtime.emitNotificationNew(recipientUserId, { notification: dto, silent: true });
      }
    } catch {
      // Best-effort
    }
  }

  /**
   * Fan-out word_of_the_day or quote_of_the_day notifications to all non-banned users.
   * Cursor-paginated in chunks of 500. Persists fanoutCursor after each chunk so a
   * mid-fan-out crash resumes without double-notifying (createMany skipDuplicates).
   * Sets wordNotifiedAt / quoteNotifiedAt when the fan-out completes.
   */
  async fanOutDailyContentNotifications(params: {
    item: 'word' | 'quote';
    dayKey: string;
  }): Promise<void> {
    const { item, dayKey } = params;

    const snap = await this.prisma.dailyContentSnapshot.findUnique({
      where: { dayKey },
      select: {
        wordNotifiedAt: true,
        quoteNotifiedAt: true,
        wordFanoutCursor: true,
        quoteFanoutCursor: true,
        websters1828: true,
        quote: true,
      },
    });

    if (!snap) {
      this.logger.warn(`[daily-content fan-out] No snapshot found for dayKey=${dayKey}`);
      return;
    }

    const alreadyNotified = item === 'word' ? snap.wordNotifiedAt : snap.quoteNotifiedAt;
    // A real timestamp (not the sentinel new Date(1)) means fan-out is done.
    if (alreadyNotified && alreadyNotified.getTime() > 1) {
      this.logger.debug(`[daily-content fan-out] ${item} already notified for ${dayKey}`);
      return;
    }

    const kind: NotificationKind = item === 'word' ? 'word_of_the_day' : 'quote_of_the_day';
    const url = item === 'word' ? '/daily/word' : '/daily/quote';

    let title: string;
    let body: string;
    if (item === 'word') {
      const wotd = snap.websters1828 as Record<string, unknown> | null;
      const word = typeof wotd?.word === 'string' ? wotd.word : '';
      title = 'Good morning!';
      body = word
        ? `Today\u2019s word is: ${word} \u2014 open for the definition.`
        : 'Open for today\u2019s word.';
    } else {
      const q = snap.quote as Record<string, unknown> | null;
      const author = typeof q?.author === 'string' ? q.author : '';
      title = 'Quote of the day';
      body = author
        ? `Today\u2019s quote is by ${author} \u2014 open to read it.`
        : 'Open to read today\u2019s quote.';
    }

    const CHUNK = 500;
    let cursor: string | undefined =
      (item === 'word' ? snap.wordFanoutCursor : snap.quoteFanoutCursor) ?? undefined;

    while (true) {
      const users = await this.prisma.user.findMany({
        where: {
          bannedAt: null,
          ...(cursor ? { id: { gt: cursor } } : {}),
        },
        orderBy: { id: 'asc' },
        take: CHUNK,
        select: { id: true },
      });

      if (users.length === 0) break;

      const userIds = users.map((u) => u.id);
      const now = new Date();

      // Count existing unread rows per user for this kind. The counter adjustment depends
      // on how many unread rows each user had:
      //   0 unread → new unread created  → +1
      //   1 unread → replaced 1-for-1    → net 0
      //   N unread → N deleted, 1 created → -(N-1)  (counter was inflated from prior days)
      const existingUnread = await this.prisma.notification.findMany({
        where: { kind, recipientUserId: { in: userIds }, deliveredAt: null },
        select: { recipientUserId: true },
      });
      const priorUnreadCount = new Map<string, number>();
      for (const r of existingUnread) {
        priorUnreadCount.set(r.recipientUserId, (priorUnreadCount.get(r.recipientUserId) ?? 0) + 1);
      }

      // Delete all prior rows of this kind for this batch — both read and unread — so only
      // the latest daily notification ever appears in the bell.
      await this.prisma.notification.deleteMany({
        where: { kind, recipientUserId: { in: userIds } },
      });

      await this.prisma.notification.createMany({
        data: userIds.map((recipientUserId) => ({
          recipientUserId,
          kind,
          title,
          body,
          createdAt: now,
        })),
      });

      // Adjust the undelivered bell counter per user:
      //   Had 0 unread → increment by 1 (batch update, fast)
      //   Had 1 unread → no change
      //   Had N > 1    → decrement by (N - 1) to remove the excess (rare after first cleanup)
      const usersNeedingIncrement = userIds.filter((id) => !priorUnreadCount.has(id));
      if (usersNeedingIncrement.length > 0) {
        await this.prisma.$executeRaw`
          UPDATE "User"
          SET "undeliveredNotificationCount" = "undeliveredNotificationCount" + 1
          WHERE id = ANY(${usersNeedingIncrement}::text[])
        `;
      }
      const usersWithExcess = userIds
        .map((id) => ({ id, excess: (priorUnreadCount.get(id) ?? 0) - 1 }))
        .filter((u) => u.excess > 0);
      if (usersWithExcess.length > 0) {
        await runInBatches(usersWithExcess, FANOUT_CONCURRENCY, async ({ id, excess }) => {
          await this.prisma.user.update({
            where: { id },
            data: { undeliveredNotificationCount: { decrement: excess } },
          });
        });
      }

      // Emit realtime badge update and queue the push. Batched rather than sequential: each
      // badge emit needs its own count query, and 500 of those in series is minutes of
      // avoidable wall-clock for a fan-out the whole user base is waiting on.
      await runInBatches(userIds, FANOUT_CONCURRENCY, async (userId) => {
        const undeliveredCount = await this.prisma.notification
          .count({ where: this.readState.undeliveredBellWhere(userId) })
          .catch(() => 0);
        this.emitBellAndInvalidateList(userId, { undeliveredCount });

        this.sideEffects.dispatch('notification.push', {
          recipientUserId: userId,
          kind,
          actorUserId: null,
          fallbackTitle: title,
          body,
          url,
        });
      });

      // Persist cursor so a crash resumes from here.
      cursor = userIds[userIds.length - 1];
      await this.prisma.dailyContentSnapshot.update({
        where: { dayKey },
        data: item === 'word'
          ? { wordFanoutCursor: cursor }
          : { quoteFanoutCursor: cursor },
      });

      if (users.length < CHUNK) break;
    }

    // Mark fan-out complete.
    await this.prisma.dailyContentSnapshot.update({
      where: { dayKey },
      data: item === 'word'
        ? { wordNotifiedAt: new Date() }
        : { quoteNotifiedAt: new Date() },
    });

    this.logger.log(`[daily-content fan-out] ${item} fan-out complete for ${dayKey}`);
  }

  // ─── checkin_reminder fan-out ─────────────────────────────────────────────

  /**
   * Fan-out 6pm ET check-in reminder to all verified-or-above users who have
   * NOT already posted a check-in today.
   * Cursor-paginated in chunks of 500. Guarded by `checkinReminderNotifiedAt`.
   */
  async fanOutCheckinReminders(params: { dayKey: string }): Promise<void> {
    const { dayKey } = params;

    const snap = await this.prisma.dailyContentSnapshot.findUnique({
      where: { dayKey },
      select: { checkinReminderNotifiedAt: true, checkinReminderFanoutCursor: true },
    });

    if (snap?.checkinReminderNotifiedAt && snap.checkinReminderNotifiedAt.getTime() > 1) {
      this.logger.debug(`[checkin-reminder fan-out] already notified for ${dayKey}`);
      return;
    }

    const kind = 'checkin_reminder' as const;
    const title = 'Have you checked in today?';
    const body = 'Tap to post your check-in and keep your streak alive.';
    const url = '/home?checkin=1';

    const CHUNK = 500;
    let cursor: string | undefined = snap?.checkinReminderFanoutCursor ?? undefined;

    while (true) {
      // Fetch verified-or-above users who haven't yet checked in today.
      const users = await this.prisma.user.findMany({
        where: {
          bannedAt: null,
          OR: [
            { verifiedStatus: { not: 'none' } },
            { premium: true },
            { premiumPlus: true },
          ],
          // Exclude users who already have a check-in post for today.
          NOT: {
            posts: {
              some: { kind: 'checkin', checkinDayKey: dayKey, deletedAt: null },
            },
          },
          ...(cursor ? { id: { gt: cursor } } : {}),
        },
        orderBy: { id: 'asc' },
        take: CHUNK,
        select: { id: true },
      });

      if (users.length === 0) break;

      const userIds = users.map((u) => u.id);
      const now = new Date();

      // Delete any existing reminder for today so we don't double-badge.
      const existingUnread = await this.prisma.notification.findMany({
        where: { kind, recipientUserId: { in: userIds }, deliveredAt: null },
        select: { recipientUserId: true },
      });
      const priorUnreadSet = new Set(existingUnread.map((r) => r.recipientUserId));

      await this.prisma.notification.deleteMany({
        where: { kind, recipientUserId: { in: userIds } },
      });

      await this.prisma.notification.createMany({
        data: userIds.map((recipientUserId) => ({
          recipientUserId,
          kind,
          title,
          body,
          createdAt: now,
        })),
      });

      const usersNeedingIncrement = userIds.filter((id) => !priorUnreadSet.has(id));
      if (usersNeedingIncrement.length > 0) {
        await this.prisma.$executeRaw`
          UPDATE "User"
          SET "undeliveredNotificationCount" = "undeliveredNotificationCount" + 1
          WHERE id = ANY(${usersNeedingIncrement}::text[])
        `;
      }

      await runInBatches(userIds, FANOUT_CONCURRENCY, async (userId) => {
        const undeliveredCount = await this.prisma.notification
          .count({ where: this.readState.undeliveredBellWhere(userId) })
          .catch(() => 0);
        this.emitBellAndInvalidateList(userId, { undeliveredCount });

        this.sideEffects.dispatch('notification.push', {
          recipientUserId: userId,
          kind,
          actorUserId: null,
          fallbackTitle: title,
          body,
          url,
        });
      });

      cursor = userIds[userIds.length - 1];
      if (!snap) {
        await this.prisma.dailyContentSnapshot.upsert({
          where: { dayKey },
          create: { dayKey, checkinReminderFanoutCursor: cursor },
          update: { checkinReminderFanoutCursor: cursor },
        });
      } else {
        await this.prisma.dailyContentSnapshot.update({
          where: { dayKey },
          data: { checkinReminderFanoutCursor: cursor },
        });
      }

      if (users.length < CHUNK) break;
    }

    await this.prisma.dailyContentSnapshot.upsert({
      where: { dayKey },
      create: { dayKey, checkinReminderNotifiedAt: new Date() },
      update: { checkinReminderNotifiedAt: new Date() },
    });
    this.logger.log(`[checkin-reminder fan-out] complete for ${dayKey}`);
  }

  // ─── on_this_day fan-out ──────────────────────────────────────────────────

  /**
   * Fan-out 8am ET "On This Day" notifications to users who had a post
   * exactly one or more years ago on this calendar date (ET month-day match).
   * Picks the most-recent matching year. Cursor-paginated in chunks of 500.
   * Guarded by `onThisDayNotifiedAt`.
   */
  async fanOutOnThisDayNotifications(params: { dayKey: string }): Promise<void> {
    const { dayKey } = params;

    const snap = await this.prisma.dailyContentSnapshot.findUnique({
      where: { dayKey },
      select: { onThisDayNotifiedAt: true, onThisDayFanoutCursor: true },
    });

    if (snap?.onThisDayNotifiedAt && snap.onThisDayNotifiedAt.getTime() > 1) {
      this.logger.debug(`[on-this-day fan-out] already notified for ${dayKey}`);
      return;
    }

    // Parse the current ET month-day to build the SQL pattern.
    // dayKey format: YYYY-MM-DD
    const [yearStr, monthStr, dayStr] = dayKey.split('-');
    const year = Number(yearStr);
    if (!year || !monthStr || !dayStr) {
      this.logger.warn(`[on-this-day fan-out] invalid dayKey=${dayKey}`);
      return;
    }
    const monthDay = `${monthStr}-${dayStr}`; // MM-DD

    const kind = 'on_this_day' as const;
    const CHUNK = 500;
    let cursor: string | undefined = snap?.onThisDayFanoutCursor ?? undefined;

    while (true) {
      // Find users who have at least one public/verifiedOnly checkin post from
      // a prior year on this same ET month-day, using a raw query for the
      // DISTINCT ON + TO_CHAR(AT TIME ZONE) matching.
      const rows = await this.prisma.$queryRaw<{ userId: string; postId: string; yearsAgo: number }[]>`
        SELECT DISTINCT ON (p."userId") p."userId" AS "userId", p.id AS "postId",
          EXTRACT(YEAR FROM now() AT TIME ZONE 'America/New_York')::int
          - EXTRACT(YEAR FROM p."createdAt" AT TIME ZONE 'America/New_York')::int AS "yearsAgo"
        FROM "Post" p
        WHERE p."kind" = 'checkin'
          AND p."deletedAt" IS NULL
          AND p."visibility" IN ('public', 'verifiedOnly')
          AND TO_CHAR(p."createdAt" AT TIME ZONE 'America/New_York', 'MM-DD') = ${monthDay}
          AND EXTRACT(YEAR FROM p."createdAt" AT TIME ZONE 'America/New_York') < ${year}
          ${cursor ? Prisma.sql`AND p."userId" > ${cursor}` : Prisma.empty}
        ORDER BY p."userId" ASC, p."createdAt" DESC
        LIMIT ${CHUNK}
      `;

      if (rows.length === 0) break;

      const now = new Date();

      const existingUnread = await this.prisma.notification.findMany({
        where: { kind, recipientUserId: { in: rows.map((r) => r.userId) }, deliveredAt: null },
        select: { recipientUserId: true },
      });
      const priorUnreadSet = new Set(existingUnread.map((r) => r.recipientUserId));

      // Delete previous on_this_day for today so only one shows in the bell.
      await this.prisma.notification.deleteMany({
        where: { kind, recipientUserId: { in: rows.map((r) => r.userId) } },
      });

      await this.prisma.notification.createMany({
        data: rows.map(({ userId, postId, yearsAgo }) => ({
          recipientUserId: userId,
          kind,
          subjectPostId: postId,
          title: 'On this day',
          body: yearsAgo === 1 ? 'You checked in 1 year ago today.' : `You checked in ${yearsAgo} years ago today.`,
          createdAt: now,
        })),
      });

      const userIds = rows.map((r) => r.userId);
      const usersNeedingIncrement = userIds.filter((id) => !priorUnreadSet.has(id));
      if (usersNeedingIncrement.length > 0) {
        await this.prisma.$executeRaw`
          UPDATE "User"
          SET "undeliveredNotificationCount" = "undeliveredNotificationCount" + 1
          WHERE id = ANY(${usersNeedingIncrement}::text[])
        `;
      }

      await runInBatches(rows, FANOUT_CONCURRENCY, async ({ userId, postId, yearsAgo }) => {
        const undeliveredCount = await this.prisma.notification
          .count({ where: this.readState.undeliveredBellWhere(userId) })
          .catch(() => 0);
        this.emitBellAndInvalidateList(userId, { undeliveredCount });

        const body = yearsAgo === 1 ? 'You checked in 1 year ago today.' : `You checked in ${yearsAgo} years ago today.`;
        this.sideEffects.dispatch('notification.push', {
          recipientUserId: userId,
          kind,
          actorUserId: null,
          fallbackTitle: 'On this day',
          body,
          url: `/p/${postId}`,
        });
      });

      cursor = userIds[userIds.length - 1];
      await this.prisma.dailyContentSnapshot.upsert({
        where: { dayKey },
        create: { dayKey, onThisDayFanoutCursor: cursor },
        update: { onThisDayFanoutCursor: cursor },
      });

      if (rows.length < CHUNK) break;
    }

    await this.prisma.dailyContentSnapshot.upsert({
      where: { dayKey },
      create: { dayKey, onThisDayNotifiedAt: new Date() },
      update: { onThisDayNotifiedAt: new Date() },
    });
    this.logger.log(`[on-this-day fan-out] complete for ${dayKey}`);
  }

  /**
   * Write a premium_started or premium_ended notification for a user.
   *
   * Deletes any prior premium_started / premium_ended rows first so a
   * subscribe → cancel → resubscribe cycle always shows the current state,
   * not a history of transitions.
   */
  async upsertPremiumStatusNotification(params: {
    recipientUserId: string;
    kind: 'premium_started' | 'premium_ended';
    isPremiumPlus: boolean;
  }): Promise<void> {
    const { recipientUserId, kind, isPremiumPlus } = params;

    // Remove stale premium transition rows before writing the fresh one.
    await this.prisma.notification.deleteMany({
      where: {
        recipientUserId,
        kind: { in: ['premium_started', 'premium_ended'] },
      },
    });

    const title =
      kind === 'premium_started'
        ? isPremiumPlus
          ? "You're Premium+"
          : "You're Premium"
        : 'Your Premium ended';
    const body =
      kind === 'premium_started'
        ? 'Premium is active. Thanks for backing Men of Hunger.'
        : 'Premium access has ended. You can restart anytime.';

    await this.create({
      recipientUserId,
      kind,
      subjectUserId: kind === 'premium_started' ? recipientUserId : undefined,
      title,
      body,
    });
  }

  /**
   * Upsert a space schedule notification for one recipient.
   * Keyed by (recipient, subjectSpaceId, kind) so cancel/live can resurface
   * and replace prior reminder rows for the same space.
   *
   * `resurface` (default true) bumps createdAt, marks unread, and sends push —
   * used when the space goes live again. Pass false to rewrite copy in place
   * ("was live") without moving the row, buzzing, or changing read state.
   * Quiet updates no-op when no row exists.
   */
  async upsertSpaceScheduleNotification(params: {
    recipientUserId: string;
    kind: 'space_reminder_day' | 'space_reminder_soon' | 'space_live' | 'space_schedule_cancelled' | 'space_schedule_rescheduled';
    spaceId: string;
    actorUserId?: string | null;
    title: string;
    body?: string | null;
    resurface?: boolean;
  }): Promise<void> {
    const { recipientUserId, kind, spaceId, actorUserId, title, body } = params;
    const resurface = params.resurface !== false;
    // Hosts are auto-subscribed to their own schedule reminders/live pings, so
    // actor === recipient is allowed here (unlike social notifications).

    if (!resurface) {
      const existing = await this.prisma.notification.findFirst({
        where: { recipientUserId, kind, subjectSpaceId: spaceId },
        select: { id: true },
      });
      if (!existing) return;
      await this.prisma.notification.update({
        where: { id: existing.id },
        data: {
          title,
          body: body ?? null,
          actorUserId: actorUserId ?? null,
        },
      });
      try {
        const dto = await this.query.buildNotificationDtoForRecipient({
          recipientUserId,
          notificationId: existing.id,
        });
        if (dto) {
          this.presenceRealtime.emitNotificationNew(recipientUserId, { notification: dto, silent: true });
        }
      } catch (err) {
        this.logger.debug(`[notifications] Failed to emit silent space_live patch: ${err}`);
      }
      return;
    }

    const presentAt = await this.presentAtForRecipient(recipientUserId);
    const { notificationId, undeliveredCount } = await this.prisma.$transaction(async (tx) => {
      const existing = await tx.notification.findFirst({
        where: { recipientUserId, kind, subjectSpaceId: spaceId },
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
            body: body ?? null,
            actorUserId: actorUserId ?? null,
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
        return { notificationId: existing.id, undeliveredCount };
      }

      const created = await tx.notification.create({
        data: {
          recipientUserId,
          kind,
          subjectSpaceId: spaceId,
          actorUserId: actorUserId ?? undefined,
          title,
          body: body ?? undefined,
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
      return { notificationId: created.id, undeliveredCount };
    });

    this.emitBellAndInvalidateList(recipientUserId, { undeliveredCount });

    try {
      const dto = await this.query.buildNotificationDtoForRecipient({
        recipientUserId,
        notificationId,
      });
      if (dto) {
        this.presenceRealtime.emitNotificationNew(recipientUserId, { notification: dto });
      }
    } catch (err) {
      this.logger.debug(`[notifications] Failed to emit notifications:new: ${err}`);
    }

    let pushUrl: string | null = null;
    const space = await this.prisma.space.findUnique({
      where: { id: spaceId },
      select: { owner: { select: { username: true } } },
    });
    const username = (space?.owner?.username ?? '').trim();
    if (username) pushUrl = `/s/${encodeURIComponent(username)}`;

    this.sideEffects.dispatch('notification.push', {
      recipientUserId,
      kind,
      actorUserId: actorUserId ?? null,
      fallbackTitle: title,
      body: body ?? null,
      actorPostId: null,
      subjectArticleId: null,
      subjectPostId: null,
      subjectUserId: null,
      subjectGroupId: null,
      subjectCommunityGroupInviteId: null,
      url: pushUrl,
      notificationId,
    });
  }

  /** Recipients who already have a space notification of this kind (one row per person). */
  async listRecipientIdsForSpaceNotification(params: {
    spaceId: string;
    kind: 'space_live';
  }): Promise<string[]> {
    const spaceId = String(params.spaceId ?? '').trim();
    if (!spaceId) return [];
    const rows = await this.prisma.notification.findMany({
      where: { subjectSpaceId: spaceId, kind: params.kind },
      select: { recipientUserId: true },
      distinct: ['recipientUserId'],
    });
    return rows.map((r) => r.recipientUserId);
  }
}
