import { permitsFollowNotification } from "./follow-notification-policy";
import { Injectable, Logger, Optional } from "@nestjs/common";
import { MutesService } from "../mutes/mutes.service";
import { type NotificationKind } from "@prisma/client";
import { PrismaService } from "../prisma/prisma.service";
import { PresenceRealtimeService } from "../presence/presence-realtime.service";
import { PresenceRedisStateService } from "../presence/presence-redis-state.service";
import { JobsService } from "../jobs/jobs.service";
import { SideEffectsService } from "../side-effects/side-effects.service";
import { NotificationQueryService } from "./notification-query.service";
import {
  isBellCountedNotificationKind,
  NotificationReadStateService,
  PERSON_ONLY_NOTIFICATION_KINDS,
} from "./notification-read-state.service";
import { CacheInvalidationService } from "../redis/cache-invalidation.service";
import { PostsReadService } from "../posts-read/posts-read.service";
import { NotificationWriterSupportService } from "./notification-writer-support.service";
import { NotificationWriterCommunityService } from "./notification-writer-community.service";
import { NotificationWriterFanoutService } from "./notification-writer-fanout.service";
import {
  ARTICLE_NOTIFICATION_CLICK_KINDS,
  articleNotificationClickPath,
} from "./notification-article-path";
import { Prisma } from "@prisma/client";
import { JOBS } from "../jobs/jobs.constants";

/** Kinds that announce the actor's own post/publish. Operators of a page actor already did the action. */
export const ACTOR_SELF_ECHO_KINDS = new Set<NotificationKind>([
  "followed_article",
  "checkin_post",
  "status_update",
]);

/**
 * Post-shaped kinds that all render as the same PostRow for a given causing post.
 * At most one of these should exist per (recipient, causing post) — a retry or a
 * comment+followed_post skip hole must not double-buzz the same reply.
 */
export const POST_CAUSED_KINDS: NotificationKind[] = [
  "comment",
  "mention",
  "followed_post",
  "checkin_post",
];
export const POST_CAUSED_KIND_SET = new Set<NotificationKind>(POST_CAUSED_KINDS);

export type CreateNotificationParams = {
  id?: string;
  actionPath?: string;
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
  private readonly support: NotificationWriterSupportService;
  private readonly community: NotificationWriterCommunityService;
  private readonly fanout: NotificationWriterFanoutService;

  constructor(
    private readonly prisma: PrismaService,
    private readonly postsRead: PostsReadService,
    private readonly presenceRealtime: PresenceRealtimeService,
    private readonly presenceRedis: PresenceRedisStateService,
    private readonly jobs: JobsService,
    private readonly sideEffects: SideEffectsService,
    private readonly query: NotificationQueryService,
    private readonly readState: NotificationReadStateService,
    private readonly cacheInvalidation?: CacheInvalidationService,
    @Optional() private readonly mutes?: MutesService,
    @Optional() support?: NotificationWriterSupportService,
    @Optional() community?: NotificationWriterCommunityService,
    @Optional() fanout?: NotificationWriterFanoutService,
  ) {
    this.support =
      support ??
      new NotificationWriterSupportService(
        prisma,
        postsRead,
        presenceRealtime,
        presenceRedis,
        sideEffects,
        readState,
        cacheInvalidation,
        mutes,
      );
    this.community =
      community ??
      new NotificationWriterCommunityService(
        prisma,
        postsRead,
        presenceRealtime,
        presenceRedis,
        jobs,
        sideEffects,
        query,
        readState,
        this.support,
        cacheInvalidation,
        mutes,
      );
    this.fanout =
      fanout ??
      new NotificationWriterFanoutService(
        prisma,
        postsRead,
        presenceRealtime,
        presenceRedis,
        jobs,
        sideEffects,
        query,
        readState,
        this.support,
        cacheInvalidation,
        mutes,
      );
    this.fanout.createNotification = (params) => this.create(params);
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
        kind: "follow",
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
    if (await this.support.recipientMutedActor(recipientUserId, actorUserId)) return;
    if (PERSON_ONLY_NOTIFICATION_KINDS.includes(kind)) {
      const recipient = await this.prisma.user.findUnique({
        where: { id: recipientUserId },
        select: { accountKind: true },
      });
      if (recipient?.accountKind === "page") return;
    }
    if (
      actorUserId &&
      ACTOR_SELF_ECHO_KINDS.has(kind) &&
      (await this.support.recipientOperatesActor(recipientUserId, actorUserId))
    ) {
      return;
    }

    if (!(await permitsFollowNotification({ follow: this.prisma.follow, post: this.postsRead.read }, params))) return;

    const fallbackTitle =
      title ??
      (
        {
          follow: "followed you",
          boost: "boosted your post",
          followed_post: "posted",
          followed_article: "published an article",
          mention: "mentioned you",
          comment: "replied to your post",
          nudge: "nudged you",
          poll_results_ready: "Poll results are ready",
          coin_transfer: "sent you coins",
          message: "sent you a message",
          group_join_request: "requests to join your group",
          community_group_member_joined: "joined the group",
          community_group_join_approved: "Your join request was approved",
          community_group_join_rejected: "Your join request was not accepted",
          community_group_member_removed: "You were removed from a group",
          community_group_disbanded: "A group you were in was disbanded",
          crew_invite_received: "invited you to their crew",
          crew_invite_accepted: "accepted your crew invite",
          crew_invite_declined: "declined your crew invite",
          crew_invite_cancelled: "cancelled their crew invite",
          crew_member_joined: "joined your crew",
          crew_member_left: "left your crew",
          crew_member_kicked: "was removed from your crew",
          crew_owner_transferred: "Crew ownership transferred",
          crew_owner_transfer_vote: "started a vote to transfer ownership",
          crew_wall_mention: "mentioned you on the crew wall",
          crew_disbanded: "Your crew was disbanded",
          community_group_invite_received: "invited you to their group",
          community_group_invite_accepted: "accepted your group invite",
          community_group_invite_declined: "declined your group invite",
          community_group_invite_cancelled: "cancelled their group invite",
          marv_not_in_group: "@marv is not in this group",
          status_update: "updated their status",
          checkin_post: "checked in",
          account_verified: "You're verified",
          premium_started: "You're Premium",
          premium_ended: "Your Premium ended",
          space_reminder_day: "Space today",
          space_reminder_soon: "Space starting soon",
          space_live: "Space is live",
          space_schedule_cancelled: "Space cancelled",
          space_schedule_rescheduled: "Space rescheduled",
          followed_space: "scheduled a space",
        } as Partial<Record<NotificationKind, string>>
      )[kind] ??
      null;

    if (
      ["comment", "mention", "followed_post"].includes(kind) &&
      !(await this.support.permitsGroupActivity(
        recipientUserId,
        actorPostId ?? subjectPostId,
        kind,
      ))
    )
      return;

    // Resolve presence before the transaction so the Redis call doesn't extend it.
    const presentAt = await this.support.presentAtForRecipient(recipientUserId);
    const causingPostId = this.support.causingPostIdForCreate(
      kind,
      actorPostId,
      subjectPostId,
    );

    const { notification, undeliveredCount, skipped } =
      await this.prisma.$transaction(async (tx) => {
        if (params.id) {
          const existing = await tx.notification.findUnique({
            where: { id: params.id },
          });
          if (existing)
            return {
              notification: existing,
              undeliveredCount: await tx.notification.count({
                where: this.readState.undeliveredBellWhere(recipientUserId),
              }),
              skipped: false,
            };
        }
        if (causingPostId) {
          const existing = await tx.notification.findFirst({
            where: this.support.postCausedExistingWhere(recipientUserId, causingPostId),
            select: { id: true },
          });
          if (existing) {
            return {
              notification: existing,
              undeliveredCount: 0,
              skipped: true as const,
            };
          }
        }

        const notification = await tx.notification.create({
          data: {
            id: params.id,
            actionPath: params.actionPath,
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
            subjectCommunityGroupInviteId:
              subjectCommunityGroupInviteId ?? undefined,
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
        return { notification, undeliveredCount, skipped: false as const };
      });

    if (skipped) return;

    this.support.emitBellAndInvalidateList(recipientUserId, {
      undeliveredCount,
    });

    // "Waiting on you" dot: a new reply just landed for this user — recompute the count.
    if (kind === "comment") {
      void this.readState.emitWaitingCountForUser(recipientUserId);
    }

    // Also emit the full notification payload so clients can update in-place without refetch.
    try {
      const dto = await this.query.buildNotificationDtoForRecipient({
        recipientUserId,
        notificationId: notification.id,
      });
      if (dto) {
        this.presenceRealtime.emitNotificationNew(recipientUserId, {
          notification: dto,
        });
      }
    } catch (err) {
      // Best-effort: never fail notification creation on realtime emission.
      this.logger.debug(
        `[notifications] Failed to emit notifications:new: ${err}`,
      );
    }

    // Web push is optional (VAPID + user preference).
    // Article kinds (including replies) always open `/a/:id` with `#comment-` when present.
    let pushUrl: string | null = ARTICLE_NOTIFICATION_CLICK_KINDS.has(kind)
      ? articleNotificationClickPath(subjectArticleId, subjectArticleCommentId)
      : null;
    if (!pushUrl) {
      pushUrl =
        kind === "comment" && actorPostId
          ? `/p/${actorPostId}`
          : kind === "mention" && actorPostId
            ? `/p/${actorPostId}`
            : (kind === "followed_post" || kind === "checkin_post") &&
                subjectPostId
              ? `/p/${subjectPostId}`
              : kind === "boost" && subjectPostId
                ? `/p/${subjectPostId}`
                : kind === "coin_transfer"
                  ? "/coins"
                  : null;
    }

    if (
      !pushUrl &&
      subjectSpaceId &&
      (kind === "space_reminder_day" ||
        kind === "space_reminder_soon" ||
        kind === "space_live" ||
        kind === "space_schedule_cancelled" ||
        kind === "space_schedule_rescheduled" ||
        kind === "followed_space")
    ) {
      const space = await this.prisma.space.findUnique({
        where: { id: subjectSpaceId },
        select: { owner: { select: { username: true } } },
      });
      const username = (space?.owner?.username ?? "").trim();
      if (username) pushUrl = `/s/${encodeURIComponent(username)}`;
    }
    // Intentionally omit sourceLabel for actor-driven pushes: the actor's words
    // (snippet) are the most valuable byte budget. sourceLabel is reserved for
    // system-originated pushes (streak reminders, daily prompt, message channel).
    this.sideEffects.dispatch("notification.push", {
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
      url: params.actionPath ?? pushUrl,
      notificationId: notification.id,
    });

    // Optional: enqueue instant email for high-signal events (mentions + replies).
    if (kind === "mention" || kind === "comment") {
      try {
        await this.jobs.enqueueCron(
          JOBS.notificationsInstantHighSignalEmail,
          { userId: recipientUserId },
          `notifications:instantHighSignalEmail:${recipientUserId}`,
          {
            delay: 2 * 60_000,
            attempts: 2,
            backoff: { type: "exponential", delay: 60_000 },
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
        kind: "boost",
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
    const {
      recipientUserId,
      actorUserId,
      subjectPostId,
      bodySnippet,
      subjectPostKind,
    } = params;
    if (
      !(await this.support.permitsGroupActivity(
        recipientUserId,
        subjectPostId,
        "boost",
      ))
    )
      return;
    // Never notify a user about their own boost.
    if (actorUserId && actorUserId === recipientUserId) return;
    if (await this.support.recipientMutedActor(recipientUserId, actorUserId)) return;
    const boostTitle =
      subjectPostKind === "status"
        ? "boosted your status"
        : "boosted your post";
    const maxAttempts = 3;
    // Resolve presence before the transaction so the Redis call doesn't extend it.
    const presentAt = await this.support.presentAtForRecipient(recipientUserId);
    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      try {
        const res = await this.prisma.$transaction(
          async (tx) => {
            const existing = await tx.notification.findFirst({
              where: {
                recipientUserId,
                actorUserId,
                subjectPostId,
                kind: "boost",
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
              return {
                kind: "updated" as const,
                notificationId: existing.id,
                undeliveredCount: null as number | null,
              };
            }

            const notification = await tx.notification.create({
              data: {
                recipientUserId,
                kind: "boost",
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
              kind: "created" as const,
              notificationId: notification.id,
              undeliveredCount,
            };
          },
          { isolationLevel: Prisma.TransactionIsolationLevel.Serializable },
        );

        if (
          res.kind === "created" &&
          typeof res.undeliveredCount === "number"
        ) {
          this.support.emitBellAndInvalidateList(recipientUserId, {
            undeliveredCount: res.undeliveredCount,
          });
        }

        // Treat as a new notification row for UI ordering (without changing delivered/read).
        try {
          const dto = await this.query.buildNotificationDtoForRecipient({
            recipientUserId,
            notificationId: res.notificationId,
          });
          if (dto) {
            this.presenceRealtime.emitNotificationNew(recipientUserId, {
              notification: dto,
            });
          }
        } catch {
          // Best-effort
        }

        // Web push is optional (VAPID + user preference). (Boosts are high-signal.)
        if (res.kind === "created") {
          this.sideEffects.dispatch("notification.push", {
            recipientUserId,
            kind: "boost",
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
        const isRetryable =
          code === "P2034" ||
          /could not serialize access/i.test(
            String((err as any)?.message ?? err),
          );
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
    const existing = await this.findExistingBoostNotification(
      recipientUserId,
      actorUserId,
      subjectPostId,
    );
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
    this.presenceRealtime.emitNotificationsDeleted(recipientUserId, {
      notificationIds: [existing.id],
    });
    this.support.emitBellAndInvalidateList(recipientUserId, { undeliveredCount });
  }

  /** Remove an article boost notification when the booster takes it back. */
  async deleteArticleBoostNotification(
    recipientUserId: string,
    actorUserId: string,
    subjectArticleId: string,
  ): Promise<void> {
    const existing = await this.prisma.notification.findFirst({
      where: { recipientUserId, actorUserId, subjectArticleId, kind: "boost" },
      select: { id: true, deliveredAt: true },
    });
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
    this.presenceRealtime.emitNotificationsDeleted(recipientUserId, {
      notificationIds: [existing.id],
    });
    this.support.emitBellAndInvalidateList(recipientUserId, { undeliveredCount });
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
    const {
      recipientUserId,
      actorUserId,
      subjectPostId,
      actorPostId,
      title = "reposted your post",
    } = params;
    if (
      !(await this.support.permitsGroupActivity(
        recipientUserId,
        actorPostId ?? subjectPostId,
        "repost",
      ))
    )
      return;
    // Never notify a user about their own repost/quote.
    if (actorUserId && actorUserId === recipientUserId) return;
    if (await this.support.recipientMutedActor(recipientUserId, actorUserId)) return;
    const isQuote = title === "quoted your post";
    const maxAttempts = 3;
    // Resolve presence before the transaction so the Redis call doesn't extend it.
    const presentAt = await this.support.presentAtForRecipient(recipientUserId);
    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      try {
        const res = await this.prisma.$transaction(
          async (tx) => {
            // Quote reposts are keyed by actorPostId (each quoting post → its own row).
            // Flat reposts are keyed by (actorUserId, subjectPostId) — one per user per post.
            const existing = await tx.notification.findFirst({
              where:
                isQuote && actorPostId
                  ? { actorPostId, kind: "repost" }
                  : {
                      recipientUserId,
                      actorUserId,
                      subjectPostId,
                      kind: "repost",
                    },
              select: { id: true, deliveredAt: true },
            });

            if (existing) {
              await tx.notification.update({
                where: { id: existing.id },
                data: {
                  createdAt: new Date(),
                  title,
                  ...(actorPostId ? { actorPostId } : {}),
                },
              });
              return {
                kind: "updated" as const,
                notificationId: existing.id,
                undeliveredCount: null as number | null,
              };
            }

            const notification = await tx.notification.create({
              data: {
                recipientUserId,
                kind: "repost",
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
            return {
              kind: "created" as const,
              notificationId: notification.id,
              undeliveredCount,
            };
          },
          { isolationLevel: Prisma.TransactionIsolationLevel.Serializable },
        );

        if (
          res.kind === "created" &&
          typeof res.undeliveredCount === "number"
        ) {
          this.support.emitBellAndInvalidateList(recipientUserId, {
            undeliveredCount: res.undeliveredCount,
          });
        }

        try {
          const dto = await this.query.buildNotificationDtoForRecipient({
            recipientUserId,
            notificationId: res.notificationId,
          });
          if (dto)
            this.presenceRealtime.emitNotificationNew(recipientUserId, {
              notification: dto,
            });
        } catch {
          /* best-effort */
        }

        // Web push for newly-created reposts (gated by pushRepost pref).
        // Updates (re-reposts of the same post) skip push to avoid re-notifying.
        if (res.kind === "created") {
          this.sideEffects.dispatch("notification.push", {
            recipientUserId,
            kind: "repost",
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
        const isRetryable =
          code === "P2034" ||
          /could not serialize access/i.test(
            String((err as any)?.message ?? err),
          );
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
      where: { recipientUserId, actorUserId, subjectPostId, kind: "repost" },
      select: { id: true, deliveredAt: true },
    });
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
    this.presenceRealtime.emitNotificationsDeleted(recipientUserId, {
      notificationIds: [existing.id],
    });
    this.support.emitBellAndInvalidateList(recipientUserId, { undeliveredCount });
  }

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
        this.sideEffects.dispatch('account.cluster.badge', { userId: uid });
        void this.cacheInvalidation?.bumpNotificationsList(uid);
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
        kind: "marv_not_in_group",
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
    const groupLabel = groupName ? `**${groupName}**` : "this group";

    await this.create({
      recipientUserId,
      kind: "marv_not_in_group",
      actorUserId: marvUserId,
      actorPostId: postId,
      subjectGroupId: groupId,
      body: `@marv is not in ${groupLabel}, so he won't respond. Ask an owner to add him!`,
    });
  }

  upsertCommunityGroupInviteReceivedNotification(
    ...args: Parameters<NotificationWriterCommunityService["upsertCommunityGroupInviteReceivedNotification"]>
  ) {
    return this.community.upsertCommunityGroupInviteReceivedNotification(...args);
  }
  upsertCommunityGroupInviteResponseNotification(
    ...args: Parameters<NotificationWriterCommunityService["upsertCommunityGroupInviteResponseNotification"]>
  ) {
    return this.community.upsertCommunityGroupInviteResponseNotification(...args);
  }
  upsertGroupMemberJoinedNotification(
    ...args: Parameters<NotificationWriterCommunityService["upsertGroupMemberJoinedNotification"]>
  ) {
    return this.community.upsertGroupMemberJoinedNotification(...args);
  }
  upsertGroupJoinDecisionNotification(
    ...args: Parameters<NotificationWriterCommunityService["upsertGroupJoinDecisionNotification"]>
  ) {
    return this.community.upsertGroupJoinDecisionNotification(...args);
  }
  upsertGroupMemberRemovedNotification(
    ...args: Parameters<NotificationWriterCommunityService["upsertGroupMemberRemovedNotification"]>
  ) {
    return this.community.upsertGroupMemberRemovedNotification(...args);
  }
  upsertGroupDisbandedNotification(
    ...args: Parameters<NotificationWriterCommunityService["upsertGroupDisbandedNotification"]>
  ) {
    return this.community.upsertGroupDisbandedNotification(...args);
  }
  upsertCrewMemberLeftNotification(
    ...args: Parameters<NotificationWriterCommunityService["upsertCrewMemberLeftNotification"]>
  ) {
    return this.community.upsertCrewMemberLeftNotification(...args);
  }
  upsertCrewMemberKickedNotification(
    ...args: Parameters<NotificationWriterCommunityService["upsertCrewMemberKickedNotification"]>
  ) {
    return this.community.upsertCrewMemberKickedNotification(...args);
  }
  upsertCrewDisbandedNotification(
    ...args: Parameters<NotificationWriterCommunityService["upsertCrewDisbandedNotification"]>
  ) {
    return this.community.upsertCrewDisbandedNotification(...args);
  }
  createGroupPostBadgeNotifications(
    ...args: Parameters<NotificationWriterCommunityService["createGroupPostBadgeNotifications"]>
  ) {
    return this.community.createGroupPostBadgeNotifications(...args);
  }
  fanOutStatusUpdateNotifications(
    ...args: Parameters<NotificationWriterFanoutService["fanOutStatusUpdateNotifications"]>
  ) {
    return this.fanout.fanOutStatusUpdateNotifications(...args);
  }
  createStatusUpdateNotification(
    ...args: Parameters<NotificationWriterFanoutService["createStatusUpdateNotification"]>
  ) {
    return this.fanout.createStatusUpdateNotification(...args);
  }
  patchStatusUpdateNotification(
    ...args: Parameters<NotificationWriterFanoutService["patchStatusUpdateNotification"]>
  ) {
    return this.fanout.patchStatusUpdateNotification(...args);
  }
  fanOutDailyContentNotifications(
    ...args: Parameters<NotificationWriterFanoutService["fanOutDailyContentNotifications"]>
  ) {
    return this.fanout.fanOutDailyContentNotifications(...args);
  }
  fanOutCheckinReminders(
    ...args: Parameters<NotificationWriterFanoutService["fanOutCheckinReminders"]>
  ) {
    return this.fanout.fanOutCheckinReminders(...args);
  }
  fanOutOnThisDayNotifications(
    ...args: Parameters<NotificationWriterFanoutService["fanOutOnThisDayNotifications"]>
  ) {
    return this.fanout.fanOutOnThisDayNotifications(...args);
  }
  upsertPremiumStatusNotification(
    ...args: Parameters<NotificationWriterFanoutService["upsertPremiumStatusNotification"]>
  ) {
    return this.fanout.upsertPremiumStatusNotification(...args);
  }
  upsertSpaceScheduleNotification(
    ...args: Parameters<NotificationWriterFanoutService["upsertSpaceScheduleNotification"]>
  ) {
    return this.fanout.upsertSpaceScheduleNotification(...args);
  }
  listRecipientIdsForSpaceNotification(
    ...args: Parameters<NotificationWriterFanoutService["listRecipientIdsForSpaceNotification"]>
  ) {
    return this.fanout.listRecipientIdsForSpaceNotification(...args);
  }
}
