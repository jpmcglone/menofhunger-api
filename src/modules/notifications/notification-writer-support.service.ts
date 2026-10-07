import { Injectable, Optional } from "@nestjs/common";
import { MutesService } from "../mutes/mutes.service";
import { Prisma, type NotificationKind } from "@prisma/client";
import { PrismaService } from "../prisma/prisma.service";
import { PresenceRealtimeService } from "../presence/presence-realtime.service";
import { PresenceRedisStateService } from "../presence/presence-redis-state.service";
import { SideEffectsService } from "../side-effects/side-effects.service";
import {
  NotificationReadStateService,
} from "./notification-read-state.service";
import { CacheInvalidationService } from "../redis/cache-invalidation.service";
import { PostsReadService } from "../posts-read/posts-read.service";

export const POST_CAUSED_KINDS: NotificationKind[] = [
  "comment",
  "mention",
  "followed_post",
  "checkin_post",
];
export const POST_CAUSED_KIND_SET = new Set<NotificationKind>(POST_CAUSED_KINDS);

@Injectable()
export class NotificationWriterSupportService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly postsRead: PostsReadService,
    private readonly presenceRealtime: PresenceRealtimeService,
    private readonly presenceRedis: PresenceRedisStateService,
    private readonly sideEffects: SideEffectsService,
    private readonly readState: NotificationReadStateService,
    private readonly cacheInvalidation?: CacheInvalidationService,
    @Optional() private readonly mutes?: MutesService,
  ) {}
  /** A recipient who muted the actor gets no notifications from them. */
  async recipientMutedActor(
    recipientUserId: string,
    actorUserId: string | null | undefined,
  ): Promise<boolean> {
    if (!this.mutes || !actorUserId) return false;
    return this.mutes.hasMuted(recipientUserId, actorUserId);
  }

  emitBellAndInvalidateList(
    recipientUserId: string,
    payload: { undeliveredCount: number },
  ): void {
    const emit = () => {
      this.presenceRealtime.emitNotificationsUpdated(recipientUserId, payload);
      void this.readState.emitNavUnreadForUser(recipientUserId);
    };
    this.sideEffects.dispatch('account.cluster.badge', { userId: recipientUserId });
    this.sideEffects.dispatch('notification.badge.sync', { recipientUserId });
    if (!this.cacheInvalidation) {
      emit();
      return;
    }
    // Bump the list version before the badge event. Clients refetch on that
    // emit; a stale page-1 cache is why All sometimes missed an in-app arrival.
    void this.cacheInvalidation
      .bumpNotificationsList(recipientUserId)
      .then(emit, emit);
  }

  /**
   * Returns the current timestamp when the recipient is actively present
   * (online and not idle, checked cross-instance via Redis), or null otherwise.
   * Used to stamp `presentAt` on new notifications so email crons can skip them —
   * the user already saw the realtime event live, so an email is redundant.
   * Never throws; presence is best-effort and must never block notification creation.
   */
  async presentAtForRecipient(userId: string): Promise<Date | null> {
    try {
      const online = await this.presenceRedis.isOnline(userId);
      if (!online) return null;
      const idle = await this.presenceRedis.isIdle(userId);
      return idle ? null : new Date();
    } catch {
      return null;
    }
  }

  /**
   * The post this row would render as a PostRow. Comment/mention key off actorPostId
   * (the reply); followed/check-in key off actorPostId or subjectPostId (the new post).
   */
  causingPostIdForCreate(
    kind: NotificationKind,
    actorPostId?: string | null,
    subjectPostId?: string | null,
  ): string | null {
    if (!POST_CAUSED_KIND_SET.has(kind)) return null;
    if (kind === "comment" || kind === "mention") {
      return (actorPostId ?? "").trim() || null;
    }
    return (actorPostId ?? subjectPostId ?? "").trim() || null;
  }

  postCausedExistingWhere(
    recipientUserId: string,
    causingPostId: string,
  ): Prisma.NotificationWhereInput {
    return {
      recipientUserId,
      OR: [
        { kind: { in: ["comment", "mention"] }, actorPostId: causingPostId },
        {
          kind: { in: ["followed_post", "checkin_post"] },
          OR: [
            { actorPostId: causingPostId },
            { subjectPostId: causingPostId },
          ],
        },
      ],
    };
  }
  async permitsGroupActivity(
    recipientUserId: string,
    postId: string | null | undefined,
    kind: string,
  ): Promise<boolean> {
    if (!postId) return true;
    const post = await this.postsRead.read.findUnique({
      where: { id: postId },
      select: { communityGroupId: true },
    });
    if (!post?.communityGroupId) return true;
    const member = await this.prisma.communityGroupMember.findUnique({
      where: {
        groupId_userId: {
          groupId: post.communityGroupId,
          userId: recipientUserId,
        },
      },
      select: { notificationPreference: true },
    });
    if (member?.notificationPreference === "muted") return false;
    return (
      member?.notificationPreference !== "repliesAndMentions" ||
      kind === "comment" ||
      kind === "mention"
    );
  }
  /** True when the recipient operates the actor page — they already performed the action. */
  async recipientOperatesActor(
    recipientUserId: string,
    actorUserId: string,
  ): Promise<boolean> {
    const recipient = String(recipientUserId ?? "").trim();
    const actor = String(actorUserId ?? "").trim();
    if (!recipient || !actor) return false;
    const row = await this.prisma.userPageOperator.findUnique({
      where: {
        operatorUserId_pageUserId: {
          operatorUserId: recipient,
          pageUserId: actor,
        },
      },
      select: { operatorUserId: true },
    });
    return Boolean(row);
  }
}
