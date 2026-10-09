import { Injectable } from "@nestjs/common";
import { isSerializationFailure } from '../../common/prisma/errors';
import { PrismaService } from "../prisma/prisma.service";
import { PresenceRealtimeService } from "../presence/presence-realtime.service";
import { SideEffectsService } from "../side-effects/side-effects.service";
import { NotificationQueryService } from "./notification-query.service";
import { NotificationReadStateService } from "./notification-read-state.service";
import { NotificationWriterSupportService } from "./notification-writer-support.service";
import { Prisma } from "@prisma/client";

@Injectable()
export class NotificationEngagementWriterService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly presenceRealtime: PresenceRealtimeService,
    private readonly sideEffects: SideEffectsService,
    private readonly query: NotificationQueryService,
    private readonly readState: NotificationReadStateService,
    private readonly support: NotificationWriterSupportService,
  ) {}

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
    if (await this.support.recipientMutedActor(recipientUserId, actorUserId))
      return;
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
        if (attempt < maxAttempts && isSerializationFailure(err)) continue;
        throw err;
      }
    }
  }

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
    this.support.emitBellAndInvalidateList(recipientUserId, {
      undeliveredCount,
    });
  }

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
    this.support.emitBellAndInvalidateList(recipientUserId, {
      undeliveredCount,
    });
  }

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
    if (await this.support.recipientMutedActor(recipientUserId, actorUserId))
      return;
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
        if (attempt < maxAttempts && isSerializationFailure(err)) continue;
        throw err;
      }
    }
  }

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
    this.support.emitBellAndInvalidateList(recipientUserId, {
      undeliveredCount,
    });
  }
}
