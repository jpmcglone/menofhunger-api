import { permitsFollowNotification } from "./follow-notification-policy";
import { Injectable, Logger } from "@nestjs/common";
import { type NotificationKind } from "@prisma/client";
import { PrismaService } from "../prisma/prisma.service";
import { PresenceRealtimeService } from "../presence/presence-realtime.service";
import { JobsService } from "../jobs/jobs.service";
import { JOBS } from "../jobs/jobs.constants";
import { SideEffectsService } from "../side-effects/side-effects.service";
import { PostsReadService } from "../posts-read/posts-read.service";
import { NotificationQueryService } from "./notification-query.service";
import { isBellCountedNotificationKind, NotificationReadStateService, PERSON_ONLY_NOTIFICATION_KINDS } from "./notification-read-state.service";
import { NotificationWriterSupportService } from "./notification-writer-support.service";
import { ARTICLE_NOTIFICATION_CLICK_KINDS, articleNotificationClickPath } from "./notification-article-path";
import { ACTOR_SELF_ECHO_KINDS, type CreateNotificationParams } from "./notification-writer.constants";

/** The single notification-row creation path: eligibility gates, the row + bell counter, realtime emit, push, and email dispatch. */
@Injectable()
export class NotificationCreatorService {
  private readonly logger = new Logger(NotificationCreatorService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly postsRead: PostsReadService,
    private readonly presenceRealtime: PresenceRealtimeService,
    private readonly jobs: JobsService,
    private readonly sideEffects: SideEffectsService,
    private readonly query: NotificationQueryService,
    private readonly readState: NotificationReadStateService,
    private readonly support: NotificationWriterSupportService,
  ) {}

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

    if (!(await permitsFollowNotification({ follow: this.prisma.follow, post: this.postsRead }, params))) return;

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
}
