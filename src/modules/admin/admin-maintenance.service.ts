import { Injectable } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { EntitlementService } from '../billing/entitlement.service';
import { PostsReadService } from '../posts-read/posts-read.service';
import { canonicalizeTopicValue } from '../../common/topics/topic-utils';
import { easternDayKey, yesterdayEasternDayKey } from '../../common/time/eastern-day-key';
import { computeCheckinStreakStats } from '../checkins/checkin-streaks';

/** One-off data repair and backfill operations behind `admin/jobs`. */
@Injectable()
export class AdminMaintenanceService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly entitlement: EntitlementService,
    private readonly postsRead: PostsReadService,
  ) {}

  async dedupeDailyContentNotifications() {
    const result = await this.prisma.$queryRaw<{ kept: bigint; deleted: bigint }[]>`
      WITH to_keep AS (
        SELECT DISTINCT ON ("recipientUserId", kind) id
        FROM "Notification"
        WHERE kind IN ('word_of_the_day', 'quote_of_the_day')
        ORDER BY "recipientUserId", kind, "createdAt" DESC
      ),
      deleted AS (
        DELETE FROM "Notification"
        WHERE kind IN ('word_of_the_day', 'quote_of_the_day')
          AND id NOT IN (SELECT id FROM to_keep)
        RETURNING "recipientUserId", "deliveredAt"
      ),
      unread_deleted AS (
        SELECT "recipientUserId", COUNT(*)::int AS cnt
        FROM deleted
        WHERE "deliveredAt" IS NULL
        GROUP BY "recipientUserId"
      ),
      counter_fix AS (
        UPDATE "User"
        SET "undeliveredNotificationCount" = GREATEST(0, "undeliveredNotificationCount" - unread_deleted.cnt)
        FROM unread_deleted
        WHERE "User".id = unread_deleted."recipientUserId"
        RETURNING 1
      )
      SELECT
        (SELECT COUNT(*) FROM to_keep) AS kept,
        (SELECT COUNT(*) FROM deleted) AS deleted
    `;
    const row = result[0] ?? { kept: BigInt(0), deleted: BigInt(0) };
    return { kept: Number(row.kept), deleted: Number(row.deleted) };
  }

  async normalizeTopics(opts: { normalizeUsers: boolean; normalizeFollows: boolean }) {
    const { normalizeUsers, normalizeFollows } = opts;

    if (normalizeUsers) {
      const users = await this.prisma.user.findMany({
        select: { id: true, interests: true },
      });
      await this.prisma.$transaction(
        users.map((u) => {
          const interests = Array.isArray(u.interests) ? (u.interests as string[]) : [];
          const next = Array.from(
            new Set(
              interests
                .map((s) => (canonicalizeTopicValue(s) ?? String(s ?? '').trim()).trim())
                .filter(Boolean),
            ),
          ).slice(0, 30);
          return this.prisma.user.update({ where: { id: u.id }, data: { interests: next } });
        }),
      );
    }

    if (normalizeFollows) {
      const rows = await this.prisma.topicFollow.findMany({
        select: { userId: true, topic: true },
      });
      // Rewrite each follow to canonical topic (delete old, upsert new).
      // Early-stage: do it in a transaction; avoids unique collisions.
      await this.prisma.$transaction(
        rows.flatMap((r) => {
          const mapped = canonicalizeTopicValue(r.topic) ?? String(r.topic ?? '').trim();
          const next = (mapped ?? '').trim();
          if (!next || next === r.topic) return [];
          return [
            this.prisma.topicFollow.deleteMany({ where: { userId: r.userId, topic: r.topic } }),
            this.prisma.topicFollow.upsert({
              where: { userId_topic: { userId: r.userId, topic: next } },
              create: { userId: r.userId, topic: next },
              update: {},
            }),
          ];
        }),
      );
    }

  }

  async backfillEntitlements() {
    const now = new Date();

    // Find users whose premium flag is stale: premium but no active Stripe sub and no active grants.
    // NOTE: Prisma/SQL `notIn` does not match NULL rows, so we must explicitly include the null case.
    const staleUsers = await this.prisma.user.findMany({
      where: {
        OR: [{ premium: true }, { premiumPlus: true }],
        AND: [
          {
            OR: [
              { stripeSubscriptionStatus: null },
              { stripeSubscriptionStatus: { notIn: ['active', 'trialing', 'past_due'] } },
            ],
          },
          { subscriptionGrants: { none: { revokedAt: null, endsAt: { gt: now } } } },
        ],
      },
      select: { id: true },
    });

    let fixed = 0;
    for (const user of staleUsers) {
      await this.entitlement.recomputeAndApply(user.id);
      fixed++;
    }

    return { scanned: staleUsers.length, fixed };
  }

  async backfillStreaks() {
    const now = new Date();
    const todayKey = easternDayKey(now);
    const yesterdayKey = yesterdayEasternDayKey(now);
    const users = await this.prisma.user.findMany({
      select: { id: true, checkinStreakDays: true, longestStreakDays: true, lastCheckinDayKey: true },
    });

    let updated = 0;

    for (const user of users) {
      const userId = user.id;
      const posts = await this.postsRead.read.findMany({
        where: { userId, kind: 'checkin', visibility: { not: 'onlyMe' }, deletedAt: null, isDraft: false },
        select: { createdAt: true, checkinDayKey: true },
        orderBy: { createdAt: 'asc' },
      });

      // Deduplicate to one entry per ET calendar day then sort.
      const dayKeys = [...new Set(posts.map((p) => p.checkinDayKey || easternDayKey(p.createdAt)))].sort();
      const stats = computeCheckinStreakStats({ dayKeys, todayKey, yesterdayKey });
      const noChange =
        (user.checkinStreakDays ?? 0) === stats.currentStreakDays &&
        (user.longestStreakDays ?? 0) === stats.longestStreakDays &&
        (user.lastCheckinDayKey ?? null) === stats.lastCheckinDayKey;
      if (noChange) continue;

      await this.prisma.user.update({
        where: { id: userId },
        data: {
          checkinStreakDays: stats.currentStreakDays,
          longestStreakDays: stats.longestStreakDays,
          lastCheckinDayKey: stats.lastCheckinDayKey,
        },
      });

      updated++;
    }

    return { scanned: users.length, updated };
  }

  async resetCoins() {
    const result = await this.prisma.user.updateMany({
      data: { coins: 1 },
    });
    return { updated: result.count, newValue: 1 };
  }
}
