import {
  Injectable,
  Inject,
  BadRequestException,
  ForbiddenException,
  NotFoundException,
} from "@nestjs/common";
import { NotificationCreatorService } from "../notifications";

import { FollowRelationshipsService } from "./follows-relationships.service";
import { PrismaService } from "../prisma/prisma.service";
import { ViewerContextService } from "../viewer/viewer-context.service";

import { type NudgeStateDto } from "../../common/dto";

@Injectable()
export class FollowNudgeService {
  constructor(
    private readonly relationships: FollowRelationshipsService,
    @Inject(NotificationCreatorService)
    private readonly notifications: Pick<NotificationCreatorService, "create">,
    private readonly prisma: PrismaService,
    private readonly viewerContext: ViewerContextService,
  ) {}

  async nudge(params: { viewerUserId: string; username: string }): Promise<{
    sent: boolean;
    blocked: boolean;
    nextAllowedAt: string | null;
  }> {
    const { viewerUserId, username } = params;
    await this.viewerContext.assertUserIdNotBanned(viewerUserId);
    const target = await this.relationships.userByUsernameOrThrow(username);
    if (target.id === viewerUserId)
      throw new BadRequestException("You cannot nudge yourself.");

    // Only allow nudges between mutual follows. If not mutual, hide this surface (404).
    const [a, b] = await Promise.all([
      this.prisma.follow.findFirst({
        where: { followerId: viewerUserId, followingId: target.id },
        select: { id: true },
      }),
      this.prisma.follow.findFirst({
        where: { followerId: target.id, followingId: viewerUserId },
        select: { id: true },
      }),
    ]);
    const viewerFollowsUser = Boolean(a);
    const userFollowsViewer = Boolean(b);
    if (!viewerFollowsUser || !userFollowsViewer)
      throw new NotFoundException("Not found.");

    const pendingMs = 24 * 60 * 60 * 1000; // 24h
    const since = new Date(Date.now() - pendingMs);

    // Unverified users may only nudge back — they cannot initiate.
    const viewer = await this.prisma.user.findUnique({
      where: { id: viewerUserId },
      select: { verifiedStatus: true, accountKind: true },
    });
    if (viewer?.accountKind === "page" || target.accountKind === "page") {
      throw new NotFoundException("Not found.");
    }
    const viewerIsVerified = viewer?.verifiedStatus !== "none";
    if (!viewerIsVerified) {
      const inboundFirst = await this.prisma.notification.findFirst({
        where: {
          kind: "nudge",
          actorUserId: target.id,
          recipientUserId: viewerUserId,
          readAt: null,
          createdAt: { gte: since },
        },
        select: { id: true },
      });
      if (!inboundFirst) {
        throw new ForbiddenException("Unverified users can only nudge back.");
      }
    }

    const lastOutbound = await this.prisma.notification.findFirst({
      where: {
        kind: "nudge",
        recipientUserId: target.id,
        actorUserId: viewerUserId,
        createdAt: { gte: since },
      },
      select: { createdAt: true, readAt: true, ignoredAt: true },
      orderBy: [{ createdAt: "desc" }, { id: "desc" }],
    });

    if (lastOutbound) {
      const acknowledgedByGotIt = Boolean(
        lastOutbound.readAt && !lastOutbound.ignoredAt,
      );
      const inboundAfter = await this.prisma.notification.findFirst({
        where: {
          kind: "nudge",
          actorUserId: target.id,
          recipientUserId: viewerUserId,
          createdAt: { gt: lastOutbound.createdAt },
        },
        select: { id: true },
      });
      if (!inboundAfter && !acknowledgedByGotIt) {
        const nextAllowedAt = new Date(
          lastOutbound.createdAt.getTime() + pendingMs,
        );
        return {
          sent: false,
          blocked: true,
          nextAllowedAt: nextAllowedAt.toISOString(),
        };
      }
    }

    // Deliberately NOT dispatched to the side-effects queue. The cooldown check above reads
    // this exact row, so here the notification IS the feature's state, not a side effect of
    // it — deferring the write would let a double-tap send two nudges. It's a single indexed
    // insert, and the expensive part (the push) is already queued inside the writer.
    await this.notifications.create({
      recipientUserId: target.id,
      kind: "nudge",
      actorUserId: viewerUserId,
      subjectUserId: viewerUserId,
      title: "nudged you",
    });

    return {
      sent: true,
      blocked: false,
      nextAllowedAt: new Date(Date.now() + pendingMs).toISOString(),
    };
  }

  async getNudgeState(params: {
    viewerUserId: string;
    targetUserId: string;
  }): Promise<NudgeStateDto> {
    const { viewerUserId, targetUserId } = params;
    const pendingMs = 24 * 60 * 60 * 1000; // 24h
    const since = new Date(Date.now() - pendingMs);

    const [lastOutbound, inbound] = await Promise.all([
      this.prisma.notification.findFirst({
        where: {
          kind: "nudge",
          actorUserId: viewerUserId,
          recipientUserId: targetUserId,
          createdAt: { gte: since },
        },
        select: { createdAt: true, readAt: true, ignoredAt: true },
        orderBy: [{ createdAt: "desc" }, { id: "desc" }],
      }),
      this.prisma.notification.findFirst({
        where: {
          kind: "nudge",
          actorUserId: targetUserId,
          recipientUserId: viewerUserId,
          readAt: null,
          createdAt: { gte: since },
        },
        select: { id: true, createdAt: true },
        orderBy: [{ createdAt: "desc" }, { id: "desc" }],
      }),
    ]);

    const hasInboundAfterOutbound = lastOutbound
      ? Boolean(
          await this.prisma.notification.findFirst({
            where: {
              kind: "nudge",
              actorUserId: targetUserId,
              recipientUserId: viewerUserId,
              createdAt: { gt: lastOutbound.createdAt },
            },
            select: { id: true },
          }),
        )
      : false;

    // Outbound is pending (blocks re-nudge) if:
    // - the viewer nudged within the last 24h, AND
    // - the target has not nudged back after that, AND
    // - the target has not acknowledged it via “Got it” (readAt set without ignoredAt).
    const acknowledgedByGotIt = Boolean(
      lastOutbound?.readAt && !lastOutbound?.ignoredAt,
    );
    const outboundPending = Boolean(
      lastOutbound && !hasInboundAfterOutbound && !acknowledgedByGotIt,
    );

    return {
      outboundPending,
      inboundPending: Boolean(inbound),
      inboundNotificationId: inbound?.id ?? null,
      outboundExpiresAt: outboundPending
        ? new Date(lastOutbound!.createdAt.getTime() + pendingMs).toISOString()
        : null,
    };
  }
}
