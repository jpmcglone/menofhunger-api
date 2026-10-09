import { Injectable } from "@nestjs/common";
import { PrismaService } from "../prisma/prisma.service";
import { NotificationReadStateService } from "./notification-read-state.service";

@Injectable()
export class NotificationNudgesService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly readState: NotificationReadStateService,
  ) {}

  async markNudgesReadByActor(
    recipientUserId: string,
    actorUserId: string,
  ): Promise<number> {
    const recipient = (recipientUserId ?? "").trim();
    const actor = (actorUserId ?? "").trim();
    if (!recipient || !actor) return 0;
    const res = await this.prisma.$transaction(async (tx) => {
      const now = new Date();
      const readRes = await tx.notification.updateMany({
        where: {
          recipientUserId: recipient,
          kind: "nudge",
          actorUserId: actor,
          readAt: null,
        },
        data: { readAt: now },
      });
      if (readRes.count === 0)
        return { changedCount: 0, undeliveredCount: null as number | null };
      const deliveredRes = await tx.notification.updateMany({
        where: {
          recipientUserId: recipient,
          kind: "nudge",
          actorUserId: actor,
          deliveredAt: null,
        },
        data: { deliveredAt: now },
      });
      if (deliveredRes.count > 0) {
        const user = await tx.user.update({
          where: { id: recipient },
          data: {
            undeliveredNotificationCount: { decrement: deliveredRes.count },
          },
          select: { undeliveredNotificationCount: true },
        });
        return {
          changedCount: readRes.count,
          undeliveredCount: user.undeliveredNotificationCount,
        };
      }
      const row = await tx.user.findUnique({
        where: { id: recipient },
        select: { undeliveredNotificationCount: true },
      });
      return {
        changedCount: readRes.count,
        undeliveredCount: row?.undeliveredNotificationCount ?? 0,
      };
    });
    if (res.changedCount > 0)
      await this.readState.emitBellRecounted(recipient, res.undeliveredCount);
    return res.changedCount;
  }

  async markNudgesNudgedBackByActor(
    recipientUserId: string,
    actorUserId: string,
  ): Promise<number> {
    const recipient = (recipientUserId ?? "").trim();
    const actor = (actorUserId ?? "").trim();
    if (!recipient || !actor) return 0;
    const res = await this.prisma.$transaction(async (tx) => {
      const now = new Date();
      const nudgedRes = await tx.notification.updateMany({
        where: {
          recipientUserId: recipient,
          kind: "nudge",
          actorUserId: actor,
          nudgedBackAt: null,
        },
        data: { nudgedBackAt: now, readAt: now },
      });
      if (nudgedRes.count === 0)
        return { changedCount: 0, undeliveredCount: null as number | null };
      const deliveredRes = await tx.notification.updateMany({
        where: {
          recipientUserId: recipient,
          kind: "nudge",
          actorUserId: actor,
          deliveredAt: null,
        },
        data: { deliveredAt: now },
      });
      if (deliveredRes.count > 0) {
        const user = await tx.user.update({
          where: { id: recipient },
          data: {
            undeliveredNotificationCount: { decrement: deliveredRes.count },
          },
          select: { undeliveredNotificationCount: true },
        });
        return {
          changedCount: nudgedRes.count,
          undeliveredCount: user.undeliveredNotificationCount,
        };
      }
      const row = await tx.user.findUnique({
        where: { id: recipient },
        select: { undeliveredNotificationCount: true },
      });
      return {
        changedCount: nudgedRes.count,
        undeliveredCount: row?.undeliveredNotificationCount ?? 0,
      };
    });
    if (res.changedCount > 0)
      await this.readState.emitBellRecounted(recipient, res.undeliveredCount);
    return res.changedCount;
  }

  async markNudgeNudgedBackById(
    recipientUserId: string,
    notificationId: string,
  ): Promise<boolean> {
    const res = await this.prisma.$transaction(async (tx) => {
      const now = new Date();
      const nudgedRes = await tx.notification.updateMany({
        where: {
          id: notificationId,
          recipientUserId,
          kind: "nudge",
          nudgedBackAt: null,
        },
        data: { nudgedBackAt: now, readAt: now },
      });
      if (nudgedRes.count === 0)
        return {
          changed: false as const,
          undeliveredCount: null as number | null,
        };
      const deliveredRes = await tx.notification.updateMany({
        where: { id: notificationId, recipientUserId, deliveredAt: null },
        data: { deliveredAt: now },
      });
      if (deliveredRes.count > 0) {
        const user = await tx.user.update({
          where: { id: recipientUserId },
          data: {
            undeliveredNotificationCount: { decrement: deliveredRes.count },
          },
          select: { undeliveredNotificationCount: true },
        });
        return {
          changed: true as const,
          undeliveredCount: user.undeliveredNotificationCount,
        };
      }
      const row = await tx.user.findUnique({
        where: { id: recipientUserId },
        select: { undeliveredNotificationCount: true },
      });
      return {
        changed: true as const,
        undeliveredCount: row?.undeliveredNotificationCount ?? 0,
      };
    });
    if (res.changed)
      await this.readState.emitBellRecounted(
        recipientUserId,
        res.undeliveredCount,
      );
    return res.changed;
  }

  async ignoreNudgesByActor(
    recipientUserId: string,
    actorUserId: string,
  ): Promise<number> {
    const recipient = (recipientUserId ?? "").trim();
    const actor = (actorUserId ?? "").trim();
    if (!recipient || !actor) return 0;
    const res = await this.prisma.$transaction(async (tx) => {
      const now = new Date();
      const ignoredRes = await tx.notification.updateMany({
        where: {
          recipientUserId: recipient,
          kind: "nudge",
          actorUserId: actor,
          ignoredAt: null,
        },
        data: { ignoredAt: now, readAt: now },
      });
      if (ignoredRes.count === 0)
        return { changedCount: 0, undeliveredCount: null as number | null };
      const deliveredRes = await tx.notification.updateMany({
        where: {
          recipientUserId: recipient,
          kind: "nudge",
          actorUserId: actor,
          deliveredAt: null,
        },
        data: { deliveredAt: now },
      });
      if (deliveredRes.count > 0) {
        const user = await tx.user.update({
          where: { id: recipient },
          data: {
            undeliveredNotificationCount: { decrement: deliveredRes.count },
          },
          select: { undeliveredNotificationCount: true },
        });
        return {
          changedCount: ignoredRes.count,
          undeliveredCount: user.undeliveredNotificationCount,
        };
      }
      const row = await tx.user.findUnique({
        where: { id: recipient },
        select: { undeliveredNotificationCount: true },
      });
      return {
        changedCount: ignoredRes.count,
        undeliveredCount: row?.undeliveredNotificationCount ?? 0,
      };
    });
    if (res.changedCount > 0)
      await this.readState.emitBellRecounted(recipient, res.undeliveredCount);
    return res.changedCount;
  }
}
