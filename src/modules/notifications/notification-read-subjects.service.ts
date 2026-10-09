import { Injectable } from "@nestjs/common";
import { PrismaService } from "../prisma/prisma.service";
import { NotificationReadStateService } from "./notification-read-state.service";
import { BELL_EXCLUDED_KINDS } from "./notification-kinds";

@Injectable()
export class NotificationReadSubjectsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly readState: NotificationReadStateService,
  ) {}

  async markReadBySubject(
    recipientUserId: string,
    params: {
      postId?: string | null;
      userId?: string | null;
      articleId?: string | null;
      crewId?: string | null;
      groupId?: string | null;
      boardThreadId?: string | null;
    },
  ): Promise<void> {
    const openedAt = new Date();
    const { postId, userId, articleId, crewId, groupId, boardThreadId } =
      params;
    // Batch path for post-only clears (views, detail page).
    if (
      postId &&
      !userId &&
      !articleId &&
      !crewId &&
      !groupId &&
      !boardThreadId
    ) {
      await this.markReadBySubjects(recipientUserId, [postId]);
      return;
    }
    if (
      !postId &&
      !userId &&
      !articleId &&
      !crewId &&
      !groupId &&
      !boardThreadId
    )
      return;

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
      or.push({ subjectUserId: userId, kind: { not: "nudge" } });
      or.push({
        kind: { in: ["followed_post", "checkin_post"] as const },
        actorUserId: userId,
      });
    }
    if (articleId) {
      or.push({ subjectArticleId: articleId });
    }
    if (boardThreadId) {
      // Opening a thread shows every comment in it, including nested replies whose
      // subject post is a parent comment rather than the thread itself.
      const inThread = {
        is: {
          kind: "board" as const,
          OR: [
            { id: boardThreadId },
            { rootId: boardThreadId },
            { parentId: boardThreadId },
          ],
        },
      };
      or.push({ actorPost: inThread });
      or.push({ subjectPost: inThread });
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
      or.push({
        subjectGroupId: groupId,
        kind: { not: "community_group_post" as const },
      });
    }
    const where = {
      recipientUserId,
      ...(boardThreadId ? { createdAt: { lte: openedAt } } : {}),
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
          ...(boardThreadId ? { createdAt: { lte: openedAt } } : {}),
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
      return tx.notification.count({
        where: this.readState.undeliveredBellWhere(recipientUserId),
      });
    });
    this.readState.emitBellUpdated(recipientUserId, {
      undeliveredCount,
      ...(postId ? { clearedPostIds: [postId] } : {}),
      ...(boardThreadId ? { clearedBoardThreadIds: [boardThreadId] } : {}),
    });
    // markReadBySubject can clear comment notifications (e.g. opening the post via tap).
    void this.readState.emitWaitingCountForUser(recipientUserId);
  }

  async markReadBySubjects(
    recipientUserId: string,
    postIds: string[],
  ): Promise<void> {
    const uid = (recipientUserId ?? "").trim();
    const ids = [
      ...new Set(
        (postIds ?? []).map((id) => (id ?? "").trim()).filter(Boolean),
      ),
    ];
    if (!uid || ids.length === 0) return;

    const postOr = [
      { subjectPostId: { in: ids } },
      { actorPostId: { in: ids } },
    ] as const;

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
            kind: "community_group_post",
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
        if (
          readRes.count === 0 &&
          deliveredBell.count === 0 &&
          deliveredGroups.count === 0
        ) {
          return {
            undeliveredCount: 0,
            groupsDelivered: 0,
            readChanged: 0,
            bellDelivered: 0,
          };
        }

        const undelivered = await tx.notification.count({
          where: this.readState.undeliveredBellWhere(uid),
        });
        return {
          undeliveredCount: undelivered,
          groupsDelivered: deliveredGroups.count,
          readChanged: readRes.count,
          bellDelivered: deliveredBell.count,
        };
      });

    // Idempotent re-views: no socket/badge work when nothing was unread/undelivered.
    if (readChanged === 0 && bellDelivered === 0 && groupsDelivered === 0)
      return;

    this.readState.emitBellUpdated(uid, {
      undeliveredCount,
      clearedPostIds: ids,
    });
    void this.readState.emitWaitingCountForUser(uid);
    if (groupsDelivered > 0) {
      void this.readState.emitGroupsUnreadForUser(uid);
    }
  }
}
