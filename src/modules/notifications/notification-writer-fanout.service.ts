import { Injectable, Logger, Optional } from "@nestjs/common";
import { MutesService } from "../mutes/mutes.service";
import { Prisma, type NotificationKind } from "@prisma/client";
import { PrismaService } from "../prisma/prisma.service";
import { PresenceRealtimeService } from "../presence/presence-realtime.service";
import { PresenceRedisStateService } from "../presence/presence-redis-state.service";
import { JobsService } from "../jobs/jobs.service";
import { FANOUT_CONCURRENCY, runInBatches } from "../side-effects/batch";
import { SideEffectsService } from "../side-effects/side-effects.service";
import { NotificationQueryService } from "./notification-query.service";
import {
  NotificationReadStateService,
} from "./notification-read-state.service";
import { CacheInvalidationService } from "../redis/cache-invalidation.service";
import {
  easternDayKey,
  yesterdayEasternDayKey,
  dayKeyToDate,
} from "../../common/time/eastern-day-key";
import { checkinReminderBody } from "../checkins/checkin-schedule";
import { PostsReadService } from "../posts-read/posts-read.service";
import { NotificationWriterSupportService } from "./notification-writer-support.service";

@Injectable()
export class NotificationWriterFanoutService {
  private readonly logger = new Logger(NotificationWriterFanoutService.name);
  createNotification?: (params: {
    recipientUserId: string;
    kind: NotificationKind;
    subjectUserId?: string;
    title?: string | null;
    body?: string | null;
  }) => Promise<unknown>;

  constructor(
    private readonly prisma: PrismaService,
    private readonly postsRead: PostsReadService,
    private readonly presenceRealtime: PresenceRealtimeService,
    private readonly presenceRedis: PresenceRedisStateService,
    private readonly jobs: JobsService,
    private readonly sideEffects: SideEffectsService,
    private readonly query: NotificationQueryService,
    private readonly readState: NotificationReadStateService,
    private readonly support: NotificationWriterSupportService,
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
        if (
          err instanceof Prisma.PrismaClientKnownRequestError &&
          (err.code === "P2034" || err.code === "P2002") &&
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
   * Fan-out word_of_the_day or quote_of_the_day notifications to all non-banned
   * person accounts. Pages are excluded — operators already get the person's copy.
   * Cursor-paginated in chunks of 500. Persists fanoutCursor after each chunk so a
   * mid-fan-out crash resumes without double-notifying (createMany skipDuplicates).
   * Sets wordNotifiedAt / quoteNotifiedAt when the fan-out completes.
   */
  async fanOutDailyContentNotifications(params: {
    item: "word" | "quote";
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
        websters1828RefreshedAt: true,
        quoteRefreshedAt: true,
      },
    });

    if (!snap) {
      this.logger.warn(
        `[daily-content fan-out] No snapshot found for dayKey=${dayKey}`,
      );
      throw new Error(`[daily-content fan-out] Missing snapshot for ${dayKey}`);
    }

    const refreshedAt =
      item === "word" ? snap.websters1828RefreshedAt : snap.quoteRefreshedAt;
    const content = (
      item === "word" ? snap.websters1828 : snap.quote
    ) as Record<string, unknown> | null;
    const requiredFields =
      item === "word" ? ["word", "definition"] : ["author", "text"];
    if (
      !refreshedAt ||
      refreshedAt.getTime() <= 1 ||
      !requiredFields.every(
        (key) =>
          typeof content?.[key] === "string" && String(content[key]).trim(),
      )
    ) {
      throw new Error(
        `[daily-content fan-out] ${item} snapshot is not ready for ${dayKey}`,
      );
    }

    const alreadyNotified =
      item === "word" ? snap.wordNotifiedAt : snap.quoteNotifiedAt;
    // A real timestamp (not the sentinel new Date(1)) means fan-out is done.
    if (alreadyNotified && alreadyNotified.getTime() > 1) {
      this.logger.debug(
        `[daily-content fan-out] ${item} already notified for ${dayKey}`,
      );
      return;
    }

    // Covers retries and directly queued fan-outs as well as the normal publish job.
    await this.presenceRealtime.emitDailyContentPublished(item, dayKey);

    const kind: NotificationKind =
      item === "word" ? "word_of_the_day" : "quote_of_the_day";
    const url = item === "word" ? "/daily/word" : "/daily/quote";

    let title: string;
    let body: string;
    if (item === "word") {
      const wotd = snap.websters1828 as Record<string, unknown> | null;
      const word = typeof wotd?.word === "string" ? wotd.word : "";
      title = "Good morning!";
      body = word
        ? `Today\u2019s word is: ${word} \u2014 open for the definition.`
        : "Open for today\u2019s word.";
    } else {
      const q = snap.quote as Record<string, unknown> | null;
      const author = typeof q?.author === "string" ? q.author : "";
      title = "Quote of the day";
      body = author
        ? `Today\u2019s quote is by ${author} \u2014 open to read it.`
        : "Open to read today\u2019s quote.";
    }

    const CHUNK = 500;
    let cursor: string | undefined =
      (item === "word" ? snap.wordFanoutCursor : snap.quoteFanoutCursor) ??
      undefined;

    while (true) {
      const users = await this.prisma.user.findMany({
        where: {
          bannedAt: null,
          accountKind: "person",
          ...(cursor ? { id: { gt: cursor } } : {}),
        },
        orderBy: { id: "asc" },
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
        priorUnreadCount.set(
          r.recipientUserId,
          (priorUnreadCount.get(r.recipientUserId) ?? 0) + 1,
        );
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
      const usersNeedingIncrement = userIds.filter(
        (id) => !priorUnreadCount.has(id),
      );
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
        await runInBatches(
          usersWithExcess,
          FANOUT_CONCURRENCY,
          async ({ id, excess }) => {
            await this.prisma.user.update({
              where: { id },
              data: { undeliveredNotificationCount: { decrement: excess } },
            });
          },
        );
      }

      // Emit realtime badge update and queue the push. Batched rather than sequential: each
      // badge emit needs its own count query, and 500 of those in series is minutes of
      // avoidable wall-clock for a fan-out the whole user base is waiting on.
      await runInBatches(userIds, FANOUT_CONCURRENCY, async (userId) => {
        const undeliveredCount = await this.prisma.notification
          .count({ where: this.readState.undeliveredBellWhere(userId) })
          .catch(() => 0);
        this.support.emitBellAndInvalidateList(userId, { undeliveredCount });

        this.sideEffects.dispatch("notification.push", {
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
        data:
          item === "word"
            ? { wordFanoutCursor: cursor }
            : { quoteFanoutCursor: cursor },
      });

      if (users.length < CHUNK) break;
    }

    // Mark fan-out complete.
    await this.prisma.dailyContentSnapshot.update({
      where: { dayKey },
      data:
        item === "word"
          ? { wordNotifiedAt: new Date() }
          : { quoteNotifiedAt: new Date() },
    });

    this.logger.log(
      `[daily-content fan-out] ${item} fan-out complete for ${dayKey}`,
    );
  }

  // ─── checkin_reminder fan-out ─────────────────────────────────────────────

  /**
   * Fan-out 8pm ET check-in reminder to verified-or-above person accounts who
   * checked in yesterday and have not yet checked in today. Pages are excluded.
   * Off `pushCheckinReminder` skips the bell and lock-screen. Cursor-paginated
   * in chunks of 500. Guarded by `checkinReminderNotifiedAt`.
   */
  async fanOutCheckinReminders(params: {
    dayKey: string;
    now?: Date;
  }): Promise<void> {
    const { dayKey } = params;
    const now = params.now ?? new Date();

    if (!dayKey || easternDayKey(now) !== dayKey) {
      this.logger.warn(
        `[checkin-reminder fan-out] skipping stale dayKey=${dayKey}`,
      );
      if (dayKey) {
        await this.prisma.dailyContentSnapshot.upsert({
          where: { dayKey },
          create: { dayKey, checkinReminderNotifiedAt: now },
          update: { checkinReminderNotifiedAt: now },
        });
      }
      return;
    }

    const snap = await this.prisma.dailyContentSnapshot.findUnique({
      where: { dayKey },
      select: {
        checkinReminderNotifiedAt: true,
        checkinReminderFanoutCursor: true,
      },
    });

    if (
      snap?.checkinReminderNotifiedAt &&
      snap.checkinReminderNotifiedAt.getTime() > 1
    ) {
      this.logger.debug(
        `[checkin-reminder fan-out] already notified for ${dayKey}`,
      );
      return;
    }

    const yesterdayKey = yesterdayEasternDayKey(dayKeyToDate(dayKey));
    const kind = "checkin_reminder" as const;
    const title = "Have you checked in today?";
    const url = "/home?checkin=1";

    const CHUNK = 500;
    let cursor: string | undefined =
      snap?.checkinReminderFanoutCursor ?? undefined;

    while (true) {
      const users = await this.prisma.user.findMany({
        where: {
          bannedAt: null,
          accountKind: "person",
          checkinStreakDays: { gt: 0 },
          OR: [
            { verifiedStatus: { not: "none" } },
            { premium: true },
            { premiumPlus: true },
          ],
          AND: [
            {
              posts: {
                some: {
                  kind: "checkin",
                  checkinDayKey: yesterdayKey,
                  deletedAt: null,
                },
              },
            },
            {
              NOT: {
                posts: {
                  some: {
                    kind: "checkin",
                    checkinDayKey: dayKey,
                    deletedAt: null,
                  },
                },
              },
            },
            {
              OR: [
                { notificationPreferences: { is: null } },
                {
                  notificationPreferences: {
                    is: { pushCheckinReminder: true },
                  },
                },
              ],
            },
          ],
          ...(cursor ? { id: { gt: cursor } } : {}),
        },
        orderBy: { id: "asc" },
        take: CHUNK,
        select: { id: true, checkinStreakDays: true },
      });

      if (users.length === 0) break;

      const userIds = users.map((u) => u.id);
      const bodyByUser = new Map(
        users.map(
          (u) => [u.id, checkinReminderBody(u.checkinStreakDays ?? 0)] as const,
        ),
      );
      const createdAt = new Date();

      // Delete any existing reminder for today so we don't double-badge.
      const existingUnread = await this.prisma.notification.findMany({
        where: { kind, recipientUserId: { in: userIds }, deliveredAt: null },
        select: { recipientUserId: true },
      });
      const priorUnreadSet = new Set(
        existingUnread.map((r) => r.recipientUserId),
      );

      await this.prisma.notification.deleteMany({
        where: { kind, recipientUserId: { in: userIds } },
      });

      await this.prisma.notification.createMany({
        data: userIds.map((recipientUserId) => ({
          recipientUserId,
          kind,
          title,
          body: bodyByUser.get(recipientUserId) ?? checkinReminderBody(1),
          createdAt,
        })),
      });

      const usersNeedingIncrement = userIds.filter(
        (id) => !priorUnreadSet.has(id),
      );
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
        this.support.emitBellAndInvalidateList(userId, { undeliveredCount });

        const body = bodyByUser.get(userId) ?? checkinReminderBody(1);
        this.sideEffects.dispatch("notification.push", {
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
   * Fan-out 8am ET "On This Day" notifications to person accounts who had a
   * check-in exactly one or more years ago on this calendar date (ET month-day).
   * Pages are excluded. Picks the most-recent matching year. Cursor-paginated
   * in chunks of 500. Guarded by `onThisDayNotifiedAt`.
   */
  async fanOutOnThisDayNotifications(params: {
    dayKey: string;
    now?: Date;
  }): Promise<void> {
    const { dayKey } = params;
    const now = params.now ?? new Date();

    if (!dayKey || easternDayKey(now) !== dayKey) {
      this.logger.warn(`[on-this-day fan-out] skipping stale dayKey=${dayKey}`);
      if (dayKey) {
        await this.prisma.dailyContentSnapshot.upsert({
          where: { dayKey },
          create: { dayKey, onThisDayNotifiedAt: now },
          update: { onThisDayNotifiedAt: now },
        });
      }
      return;
    }

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
    const [yearStr, monthStr, dayStr] = dayKey.split("-");
    const year = Number(yearStr);
    if (!year || !monthStr || !dayStr) {
      this.logger.warn(`[on-this-day fan-out] invalid dayKey=${dayKey}`);
      return;
    }
    const monthDay = `${monthStr}-${dayStr}`; // MM-DD

    const kind = "on_this_day" as const;
    const CHUNK = 500;
    let cursor: string | undefined = snap?.onThisDayFanoutCursor ?? undefined;

    while (true) {
      // Find users who have at least one public/verifiedOnly checkin post from
      // a prior year on this same ET month-day, using a raw query for the
      // DISTINCT ON + TO_CHAR(AT TIME ZONE) matching.
      const rows = await this.prisma.$queryRaw<
        { userId: string; postId: string; yearsAgo: number }[]
      >`
        SELECT DISTINCT ON (p."userId") p."userId" AS "userId", p.id AS "postId",
          EXTRACT(YEAR FROM now() AT TIME ZONE 'America/New_York')::int
          - EXTRACT(YEAR FROM p."createdAt" AT TIME ZONE 'America/New_York')::int AS "yearsAgo"
        FROM "Post" p
        INNER JOIN "User" u ON u.id = p."userId" AND u."accountKind" = 'person'
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
        where: {
          kind,
          recipientUserId: { in: rows.map((r) => r.userId) },
          deliveredAt: null,
        },
        select: { recipientUserId: true },
      });
      const priorUnreadSet = new Set(
        existingUnread.map((r) => r.recipientUserId),
      );

      // Delete previous on_this_day for today so only one shows in the bell.
      await this.prisma.notification.deleteMany({
        where: { kind, recipientUserId: { in: rows.map((r) => r.userId) } },
      });

      await this.prisma.notification.createMany({
        data: rows.map(({ userId, postId, yearsAgo }) => ({
          recipientUserId: userId,
          kind,
          subjectPostId: postId,
          title: "On this day",
          body:
            yearsAgo === 1
              ? "You checked in 1 year ago today."
              : `You checked in ${yearsAgo} years ago today.`,
          createdAt: now,
        })),
      });

      const userIds = rows.map((r) => r.userId);
      const usersNeedingIncrement = userIds.filter(
        (id) => !priorUnreadSet.has(id),
      );
      if (usersNeedingIncrement.length > 0) {
        await this.prisma.$executeRaw`
          UPDATE "User"
          SET "undeliveredNotificationCount" = "undeliveredNotificationCount" + 1
          WHERE id = ANY(${usersNeedingIncrement}::text[])
        `;
      }

      await runInBatches(
        rows,
        FANOUT_CONCURRENCY,
        async ({ userId, postId, yearsAgo }) => {
          const undeliveredCount = await this.prisma.notification
            .count({ where: this.readState.undeliveredBellWhere(userId) })
            .catch(() => 0);
          this.support.emitBellAndInvalidateList(userId, { undeliveredCount });

          const body =
            yearsAgo === 1
              ? "You checked in 1 year ago today."
              : `You checked in ${yearsAgo} years ago today.`;
          this.sideEffects.dispatch("notification.push", {
            recipientUserId: userId,
            kind,
            actorUserId: null,
            fallbackTitle: "On this day",
            body,
            url: `/p/${postId}`,
          });
        },
      );

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

    await this.createNotification?.({
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
