import { Injectable, Logger, Optional } from "@nestjs/common";
import { isSerializationFailure, isUniqueViolation } from '../../common/prisma/errors';
import { MutesService } from "../mutes/mutes.service";
import { Prisma } from "@prisma/client";
import { PrismaService } from "../prisma/prisma.service";
import { PresenceRealtimeService } from "../presence/presence-realtime.service";
import { JobsService } from "../jobs/jobs.service";
import { FANOUT_CONCURRENCY, runInBatches } from "../side-effects/batch";
import { SideEffectsService } from "../side-effects/side-effects.service";
import { NotificationQueryService } from "./notification-query.service";
import { NotificationReadStateService } from "./notification-read-state.service";
import { CacheInvalidationService } from "../redis/cache-invalidation.service";
import { PostsReadService } from "../posts-read/posts-read.service";
import { NotificationWriterSupportService } from "./notification-writer-support.service";
import { NotificationCreatorService } from './notification-creator.service';

@Injectable()
export class NotificationWriterFanoutService {
  readonly logger = new Logger(NotificationWriterFanoutService.name);
  constructor(
    private readonly prisma: PrismaService,
    private readonly postsRead: PostsReadService,
    private readonly presenceRealtime: PresenceRealtimeService,
    private readonly jobs: JobsService,
    private readonly sideEffects: SideEffectsService,
    private readonly query: NotificationQueryService,
    private readonly readState: NotificationReadStateService,
    private readonly support: NotificationWriterSupportService,
    private readonly creator: NotificationCreatorService,
    private readonly cacheInvalidation?: CacheInvalidationService,
    @Optional() private readonly mutes?: MutesService,
  ) {}
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
    mode: "created" | "edited";
  }): Promise<void> {
    const { actorUserId, text, postId, mode } = params;

    const [actor, follows, operators] = await Promise.all([
      this.prisma.user.findUnique({
        where: { id: actorUserId },
        select: { username: true },
      }),
      this.prisma.follow.findMany({
        where: { followingId: actorUserId },
        select: { followerId: true },
      }),
      this.prisma.userPageOperator.findMany({
        where: { pageUserId: actorUserId },
        select: { operatorUserId: true },
      }),
    ]);

    if (!actor || follows.length === 0) return;
    const actorUsername = actor.username ?? "";
    const operatorIds = new Set(operators.map((row) => row.operatorUserId));

    const recipientIds = follows
      .map((f) => f.followerId)
      .filter((id) => id && id !== actorUserId && !operatorIds.has(id));

    const result = await runInBatches(
      recipientIds,
      FANOUT_CONCURRENCY,
      async (recipientUserId) => {
        const args = {
          recipientUserId,
          actorUserId,
          actorUsername,
          text,
          postId,
        };
        await (mode === "created"
          ? this.createStatusUpdateNotification(args)
          : this.patchStatusUpdateNotification(args));
      },
    );

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
    const { recipientUserId, actorUserId, actorUsername, text, postId } =
      params;
    if (actorUserId === recipientUserId) return;
    if (await this.support.recipientOperatesActor(recipientUserId, actorUserId)) return;
    if (await this.support.recipientMutedActor(recipientUserId, actorUserId)) return;

    const maxAttempts = 3;
    const presentAt = await this.support.presentAtForRecipient(recipientUserId);

    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      try {
        const res = await this.prisma.$transaction(
          async (tx) => {
            const notification = await tx.notification.create({
              data: {
                recipientUserId,
                kind: "status_update",
                actorUserId,
                subjectUserId: actorUserId,
                subjectPostId: postId ?? undefined,
                title: "updated their status",
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

        this.support.emitBellAndInvalidateList(recipientUserId, {
          undeliveredCount: res.undeliveredCount,
        });

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

        // Deliberately no subjectPostId: buildPushTag prefers it over subjectUserId, which
        // would give every status its own coalesce tag and let a burst of statuses buzz the
        // follower once each. Keeping the tag actor-scoped means the in-app rows stay
        // one-per-status while pushes collapse inside the status_update coalesce window.
        // The deep link is passed explicitly via `url` instead.
        this.sideEffects.dispatch("notification.push", {
          recipientUserId,
          kind: "status_update",
          actorUserId,
          fallbackTitle: "updated their status",
          body: text,
          subjectUserId: actorUserId,
          url: postId ? `/p/${postId}` : `/u/${actorUsername}`,
          notificationId: res.notificationId,
        });

        return;
      } catch (err) {
        if ((isSerializationFailure(err) || isUniqueViolation(err)) && attempt < maxAttempts) {
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
      where: { recipientUserId, actorUserId, kind: "status_update" },
      orderBy: { createdAt: "desc" },
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
        this.presenceRealtime.emitNotificationNew(recipientUserId, {
          notification: dto,
          silent: true,
        });
      }
    } catch {
      // Best-effort
    }
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
    kind: "premium_started" | "premium_ended";
    isPremiumPlus: boolean;
  }): Promise<void> {
    const { recipientUserId, kind, isPremiumPlus } = params;

    // Remove stale premium transition rows before writing the fresh one.
    await this.prisma.notification.deleteMany({
      where: {
        recipientUserId,
        kind: { in: ["premium_started", "premium_ended"] },
      },
    });

    const title =
      kind === "premium_started"
        ? isPremiumPlus
          ? "You're Premium+"
          : "You're Premium"
        : "Your Premium ended";
    const body =
      kind === "premium_started"
        ? "Premium is active. Thanks for backing Men of Hunger."
        : "Premium access has ended. You can restart anytime.";

    await this.creator.create({
      recipientUserId,
      kind,
      subjectUserId: kind === "premium_started" ? recipientUserId : undefined,
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
    kind:
      | "space_reminder_day"
      | "space_reminder_soon"
      | "space_live"
      | "space_schedule_cancelled"
      | "space_schedule_rescheduled"
      | "followed_space";
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
          this.presenceRealtime.emitNotificationNew(recipientUserId, {
            notification: dto,
            silent: true,
          });
        }
      } catch (err) {
        this.logger.debug(
          `[notifications] Failed to emit silent space_live patch: ${err}`,
        );
      }
      return;
    }

    const presentAt = await this.support.presentAtForRecipient(recipientUserId);
    const { notificationId, undeliveredCount } = await this.prisma.$transaction(
      async (tx) => {
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
      },
    );

    this.support.emitBellAndInvalidateList(recipientUserId, { undeliveredCount });

    try {
      const dto = await this.query.buildNotificationDtoForRecipient({
        recipientUserId,
        notificationId,
      });
      if (dto) {
        this.presenceRealtime.emitNotificationNew(recipientUserId, {
          notification: dto,
        });
      }
    } catch (err) {
      this.logger.debug(
        `[notifications] Failed to emit notifications:new: ${err}`,
      );
    }

    let pushUrl: string | null = null;
    const space = await this.prisma.space.findUnique({
      where: { id: spaceId },
      select: { owner: { select: { username: true } } },
    });
    const username = (space?.owner?.username ?? "").trim();
    if (username) pushUrl = `/s/${encodeURIComponent(username)}`;

    this.sideEffects.dispatch("notification.push", {
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
    kind: "space_live";
  }): Promise<string[]> {
    const spaceId = String(params.spaceId ?? "").trim();
    if (!spaceId) return [];
    const rows = await this.prisma.notification.findMany({
      where: { subjectSpaceId: spaceId, kind: params.kind },
      select: { recipientUserId: true },
      distinct: ["recipientUserId"],
    });
    return rows.map((r) => r.recipientUserId);
  }
}
