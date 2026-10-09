import { Injectable, Logger } from "@nestjs/common";
import { PrismaService } from "../prisma/prisma.service";
import { PresenceRealtimeService } from "../presence/presence-realtime.service";
import { SideEffectsService } from "../side-effects/side-effects.service";
import { NotificationReadStateService } from "./notification-read-state.service";
import { NotificationWriterSupportService } from "./notification-writer-support.service";
import { NOT_BANNED_USER_WHERE } from "../../common/prisma-selects/user.where";
import { Prisma, type NotificationKind } from "@prisma/client";
import { FANOUT_CONCURRENCY, runInBatches } from "../side-effects/batch";
import {
  easternDayKey,
  yesterdayEasternDayKey,
  dayKeyToDate,
} from "../../common/time/eastern-day-key";
import { checkinReminderBody } from "../checkins/checkin-schedule";
import { NOT_DELETED } from '../../common/prisma/where';

@Injectable()
export class NotificationFanoutContentService {
  private readonly logger = new Logger(NotificationFanoutContentService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly presenceRealtime: PresenceRealtimeService,
    private readonly sideEffects: SideEffectsService,
    private readonly readState: NotificationReadStateService,
    private readonly support: NotificationWriterSupportService,
  ) {}

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
          ...NOT_BANNED_USER_WHERE,
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
          ...NOT_BANNED_USER_WHERE,
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
                  ...NOT_DELETED,
                },
              },
            },
            {
              NOT: {
                posts: {
                  some: {
                    kind: "checkin",
                    checkinDayKey: dayKey,
                    ...NOT_DELETED,
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
}
