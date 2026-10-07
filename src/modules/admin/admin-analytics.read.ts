import { Prisma } from "@prisma/client";
import { PrismaService } from "../prisma/prisma.service";
import { LandingService } from "../landing/landing.service";
import { assembleAdminAnalytics } from "./admin-analytics.assemble";
import type {
  AnalyticsGranularity,
  AnalyticsRange,
} from "../../common/dto/admin-analytics.dto";

function resolveSince(range: string, now: Date): Date | null {
  const ms = (days: number) => new Date(now.getTime() - days * 86400000);
  switch (range as AnalyticsRange) {
    case "7d":
      return ms(7);
    case "30d":
      return ms(30);
    case "3m":
      return ms(90);
    case "1y":
      return ms(365);
    case "all":
      return null;
    default:
      return ms(30);
  }
}

function granularityForSpan(days: number): AnalyticsGranularity {
  if (days <= 45) return "day";
  if (days <= 180) return "week";
  return "month";
}

export function toTimeSeries(rows: Array<{ bucket: Date; count: bigint }>) {
  return rows.map((r) => ({
    bucket: r.bucket.toISOString().split("T")[0]!,
    count: Number(r.count),
  }));
}

export async function readAdminAnalytics(
  prisma: PrismaService,
  landing: LandingService,
  rangeParam = "30d",
) {
  const now = new Date();
  const since = resolveSince(rangeParam, now);

  // "Today" midnight UTC — used to exclude the current partial day from DAU
  const todayMidnight = new Date(
    Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()),
  );
  const thirtyDaysAgo = new Date(todayMidnight.getTime() - 30 * 86400000);
  const tenWeeksAgo = new Date(todayMidnight.getTime() - 70 * 86400000);

  // Determine actual data start so granularity adapts to what we have,
  // not just what was requested (e.g. "3 months" with only 28 days of data stays daily).
  const dataStartRow = await prisma.$queryRaw<
    Array<{ data_start: Date | null }>
  >`
      SELECT MIN("createdAt") AS data_start FROM "User" WHERE "bannedAt" IS NULL
    `;
  const dataStart = dataStartRow[0]?.data_start ?? now;
  const chosen = since && since > dataStart ? since : dataStart;
  // Truncate to UTC midnight so generate_series produces exact midnight timestamps
  // that match the UserDailyActivity.day column (always stored as UTC midnight).
  const effectiveStart = new Date(
    Date.UTC(
      chosen.getUTCFullYear(),
      chosen.getUTCMonth(),
      chosen.getUTCDate(),
    ),
  );
  const actualSpanDays = Math.ceil(
    (now.getTime() - effectiveStart.getTime()) / 86400000,
  );
  const granularity = granularityForSpan(actualSpanDays);

  // Returns an `AND col >= $n` fragment, or empty if no date filter
  const sinceAnd = (col: Prisma.Sql) =>
    since ? Prisma.sql`AND ${col} >= ${since}::timestamptz` : Prisma.sql``;

  const [
    summaryRow,
    publicPostsSummaryRow,
    activeGrantsCountRow,
    dauMauRow,
    signupsRaw,
    userPostsRaw,
    aiPostsRaw,
    checkinsRaw,
    userMessagesRaw,
    aiMessagesRaw,
    followsRaw,
    retentionRaw,
    d30Raw,
    activationRaw,
    creatorRaw,
    networkRaw,
    monetizationTotalsRaw,
    monetizationByStatusRaw,
    postVisibilityRaw,
    topPostsAllTimeRaw,
    articleSummaryRaw,
    articleVisibilityRaw,
    articlePublishedRaw,
    articleViewsRaw,
    articleEngagementRaw,
    totalCoinsRow,
    articleTopRaw,
    coinsMintedSummaryRaw,
    coinsTransferredSummaryRaw,
    coinsMintedSeriesRaw,
    coinsMintedByMultiplierRaw,
    coinsGiniRaw,
  ] = await Promise.all([
    // All-time summary counts (range-independent).
    // Note: premiumPlus users also have premium=true, so premium_users already
    // includes all paid tiers. Don't add premium_users + premium_plus_users in the UI.
    prisma.$queryRaw<
      Array<{
        total_users: bigint;
        verified_users: bigint;
        premium_users: bigint;
        premium_plus_users: bigint;
      }>
    >`
        SELECT
          COUNT(*)::bigint AS total_users,
          COUNT(*) FILTER (WHERE "verifiedStatus" != 'none')::bigint AS verified_users,
          COUNT(*) FILTER (WHERE "premium" = true)::bigint AS premium_users,
          COUNT(*) FILTER (WHERE "premiumPlus" = true)::bigint AS premium_plus_users
        FROM "User"
        WHERE "bannedAt" IS NULL
          AND "isBot" = false
      `,

    // All-time public regular posts used for public-facing proof and leaderboards.
    prisma.$queryRaw<Array<{ cnt: bigint }>>`
        SELECT COUNT(*)::bigint AS cnt
        FROM "Post"
        WHERE "deletedAt" IS NULL
          AND "isDraft" = false
          AND "kind" = 'regular'
          AND "visibility" = 'public'
      `,

    // Users with at least one active grant (non-revoked, not yet expired).
    // Range-independent: shows the current banked state regardless of filter.
    prisma.$queryRaw<Array<{ cnt: bigint }>>`
        SELECT COUNT(DISTINCT "userId")::bigint AS cnt
        FROM "SubscriptionGrant"
        WHERE "revokedAt" IS NULL
          AND "endsAt" > ${now}::timestamptz
      `,

    // DAU = average unique daily active users across the selected range
    // (today excluded — it's partial and would drag the average down).
    // MAU = distinct users active at any point in the last 30 days (always fixed — definitionally monthly).
    // Cast to ::timestamp (not ::timestamptz) because "day" is TIMESTAMP WITHOUT
    // TIME ZONE.  Mixing types mis-aligns the JOIN when session tz ≠ UTC.
    prisma.$queryRaw<Array<{ dau: number | null; mau: bigint }>>(Prisma.sql`
        WITH day_series AS (
          SELECT generate_series(
            ${effectiveStart}::timestamp,
            ${todayMidnight}::timestamp - INTERVAL '1 day',
            '1 day'::interval
          ) AS day
        ),
        daily AS (
          SELECT DATE_TRUNC('day', uda."day") AS day, COUNT(DISTINCT uda."userId")::float AS cnt
          FROM "UserDailyActivity" uda
          JOIN "User" u ON u.id = uda."userId" AND u."isBot" = false
          WHERE uda."day" >= ${effectiveStart}::timestamp
            AND uda."day" <  ${todayMidnight}::timestamp
          GROUP BY 1
        )
        SELECT
          AVG(COALESCE(daily.cnt, 0)) AS dau,
          (SELECT COUNT(DISTINCT uda."userId")::bigint
           FROM "UserDailyActivity" uda
           JOIN "User" u ON u.id = uda."userId" AND u."isBot" = false
           WHERE uda."day" >= ${thirtyDaysAgo}::timestamp) AS mau
        FROM day_series
        LEFT JOIN daily ON daily.day = day_series.day
      `),

    // Signups — range-filtered, granularity-bucketed; bots excluded
    prisma.$queryRaw<Array<{ bucket: Date; count: bigint }>>(Prisma.sql`
        SELECT DATE_TRUNC(${granularity}, "createdAt") AS bucket, COUNT(*)::bigint AS count
        FROM "User"
        WHERE "bannedAt" IS NULL
          AND "isBot" = false
        ${sinceAnd(Prisma.sql`"createdAt"`)}
        GROUP BY 1
        ORDER BY 1
      `),

    // User posts (regular, published, visible — bot authors excluded)
    prisma.$queryRaw<Array<{ bucket: Date; count: bigint }>>(Prisma.sql`
        SELECT DATE_TRUNC(${granularity}, p."createdAt") AS bucket, COUNT(*)::bigint AS count
        FROM "Post" p
        JOIN "User" u ON u.id = p."userId" AND u."isBot" = false
        WHERE p."deletedAt" IS NULL
          AND p."isDraft" = false
          AND p."kind" = 'regular'
          AND p."visibility" != 'onlyMe'
        ${sinceAnd(Prisma.sql`p."createdAt"`)}
        GROUP BY 1
        ORDER BY 1
      `),

    // AI posts (regular, published, visible — bot authors only)
    prisma.$queryRaw<Array<{ bucket: Date; count: bigint }>>(Prisma.sql`
        SELECT DATE_TRUNC(${granularity}, p."createdAt") AS bucket, COUNT(*)::bigint AS count
        FROM "Post" p
        JOIN "User" u ON u.id = p."userId" AND u."isBot" = true
        WHERE p."deletedAt" IS NULL
          AND p."isDraft" = false
          AND p."kind" = 'regular'
          AND p."visibility" != 'onlyMe'
        ${sinceAnd(Prisma.sql`p."createdAt"`)}
        GROUP BY 1
        ORDER BY 1
      `),

    // Check-ins (published only)
    prisma.$queryRaw<Array<{ bucket: Date; count: bigint }>>(Prisma.sql`
        SELECT DATE_TRUNC(${granularity}, "createdAt") AS bucket, COUNT(*)::bigint AS count
        FROM "Post"
        WHERE "deletedAt" IS NULL
          AND "isDraft" = false
          AND "kind" = 'checkin'
        ${sinceAnd(Prisma.sql`"createdAt"`)}
        GROUP BY 1
        ORDER BY 1
      `),

    // User messages (bot senders excluded)
    prisma.$queryRaw<Array<{ bucket: Date; count: bigint }>>(Prisma.sql`
        SELECT DATE_TRUNC(${granularity}, m."createdAt") AS bucket, COUNT(*)::bigint AS count
        FROM "Message" m
        JOIN "User" u ON u.id = m."senderId" AND u."isBot" = false
        WHERE 1=1
        ${sinceAnd(Prisma.sql`m."createdAt"`)}
        GROUP BY 1
        ORDER BY 1
      `),

    // AI messages (bot senders only)
    prisma.$queryRaw<Array<{ bucket: Date; count: bigint }>>(Prisma.sql`
        SELECT DATE_TRUNC(${granularity}, m."createdAt") AS bucket, COUNT(*)::bigint AS count
        FROM "Message" m
        JOIN "User" u ON u.id = m."senderId" AND u."isBot" = true
        WHERE 1=1
        ${sinceAnd(Prisma.sql`m."createdAt"`)}
        GROUP BY 1
        ORDER BY 1
      `),

    // Follows
    prisma.$queryRaw<Array<{ bucket: Date; count: bigint }>>(Prisma.sql`
        SELECT DATE_TRUNC(${granularity}, "createdAt") AS bucket, COUNT(*)::bigint AS count
        FROM "Follow"
        WHERE 1=1
        ${sinceAnd(Prisma.sql`"createdAt"`)}
        GROUP BY 1
        ORDER BY 1
      `),

    // Weekly cohort retention — 10-week window.
    // Excludes the current calendar week: users who signed up this week can't
    // have had a W1 yet, so including them would always show 0% for W1.
    prisma.$queryRaw<
      Array<{
        cohort_week: Date;
        size: bigint;
        retained_w1: bigint;
        retained_w4: bigint;
      }>
    >`
        WITH cohorts AS (
          SELECT
            DATE_TRUNC('week', "createdAt") AS cohort_week,
            id AS user_id
          FROM "User"
          WHERE "createdAt" >= ${tenWeeksAgo}::timestamptz
            AND "createdAt" <  DATE_TRUNC('week', ${now}::timestamptz)
            AND "bannedAt" IS NULL
            AND "isBot" = false
        ),
        activity AS (
          SELECT DISTINCT "userId", DATE_TRUNC('week', "day") AS active_week
          FROM "UserDailyActivity"
          WHERE "day" >= ${tenWeeksAgo}::timestamp
        )
        SELECT
          c.cohort_week,
          COUNT(DISTINCT c.user_id)::bigint AS size,
          COUNT(DISTINCT a1."userId")::bigint AS retained_w1,
          COUNT(DISTINCT a4."userId")::bigint AS retained_w4
        FROM cohorts c
        LEFT JOIN activity a1
          ON a1."userId" = c.user_id
          AND a1.active_week = c.cohort_week + INTERVAL '1 week'
        LEFT JOIN activity a4
          ON a4."userId" = c.user_id
          AND a4.active_week = c.cohort_week + INTERVAL '4 weeks'
        GROUP BY c.cohort_week
        ORDER BY c.cohort_week
      `,

    // D30 retention: users who signed up 30–37 days ago, still active in the last 7 days.
    // Cohort window is 7 days wide so we always have a meaningful sample size.
    prisma.$queryRaw<Array<{ cohort_size: bigint; retained_count: bigint }>>`
        WITH cohort AS (
          SELECT id FROM "User"
          WHERE "createdAt" >= ${new Date(todayMidnight.getTime() - 37 * 86400000)}::timestamptz
            AND "createdAt" <  ${new Date(todayMidnight.getTime() - 30 * 86400000)}::timestamptz
            AND "bannedAt" IS NULL
            AND "isBot" = false
        ),
        retained AS (
          SELECT DISTINCT "userId"
          FROM "UserDailyActivity"
          WHERE "userId" IN (SELECT id FROM cohort)
            AND "day" >= ${new Date(todayMidnight.getTime() - 7 * 86400000)}::timestamp
        )
        SELECT
          COUNT(cohort.id)::bigint AS cohort_size,
          COUNT(retained."userId")::bigint AS retained_count
        FROM cohort
        LEFT JOIN retained ON retained."userId" = cohort.id
      `,

    // Activation rate: of users 7+ days old, how many had any activity in their first 7 days?
    // Includes signup day (day 0) through day 6.
    prisma.$queryRaw<
      Array<{ eligible_count: bigint; activated_count: bigint }>
    >`
        WITH eligible AS (
          SELECT id, "createdAt" FROM "User"
          WHERE "createdAt" <= ${new Date(todayMidnight.getTime() - 7 * 86400000)}::timestamptz
            AND "bannedAt" IS NULL
            AND "isBot" = false
        ),
        activated AS (
          SELECT DISTINCT e.id
          FROM eligible e
          WHERE EXISTS (
            SELECT 1 FROM "UserDailyActivity" uda
            WHERE uda."userId" = e.id
              AND uda."day" >= DATE_TRUNC('day', e."createdAt")
              AND uda."day" <  DATE_TRUNC('day', e."createdAt") + INTERVAL '7 days'
          )
        )
        SELECT
          COUNT(eligible.id)::bigint AS eligible_count,
          COUNT(activated.id)::bigint AS activated_count
        FROM eligible
        LEFT JOIN activated ON activated.id = eligible.id
      `,

    // Creator %: of MAU, how many created content in the last 30 days?
    // Counts users who posted/checked-in, published an article, or hosted an active space.
    // Drafts excluded.
    prisma.$queryRaw<Array<{ mau_count: bigint; creator_count: bigint }>>`
        WITH mau_users AS (
          SELECT DISTINCT uda."userId"
          FROM "UserDailyActivity" uda
          JOIN "User" u ON u.id = uda."userId" AND u."isBot" = false
          WHERE uda."day" >= ${thirtyDaysAgo}::timestamp
        ),
        creators AS (
          SELECT DISTINCT "userId" FROM "Post"
          WHERE "createdAt" >= ${thirtyDaysAgo}::timestamptz
            AND "deletedAt" IS NULL
            AND "isDraft" = false
            AND "userId" IN (SELECT "userId" FROM mau_users)
          UNION
          SELECT DISTINCT "authorId" AS "userId" FROM "Article"
          WHERE "publishedAt" >= ${thirtyDaysAgo}::timestamptz
            AND "deletedAt" IS NULL
            AND "authorId" IN (SELECT "userId" FROM mau_users)
          UNION
          SELECT DISTINCT "ownerId" AS "userId" FROM "Space"
          WHERE "isActive" = true
            AND "ownerId" IN (SELECT "userId" FROM mau_users)
        )
        SELECT
          COUNT(DISTINCT mau_users."userId")::bigint AS mau_count,
          COUNT(DISTINCT creators."userId")::bigint AS creator_count
        FROM mau_users
        LEFT JOIN creators ON creators."userId" = mau_users."userId"
      `,

    // Network density.
    // COALESCE before AVG ensures users with 0 followers count as 0 in the average,
    // not as NULL (which AVG would silently skip, overstating the result).
    prisma.$queryRaw<
      Array<{
        avg_followers: number;
        total_users: bigint;
        connected_count: bigint;
      }>
    >`
        WITH follower_counts AS (
          SELECT "followingId" AS user_id, COUNT(*)::int AS followers
          FROM "Follow"
          GROUP BY "followingId"
        ),
        following_counts AS (
          SELECT "followerId" AS user_id, COUNT(*)::int AS following
          FROM "Follow"
          GROUP BY "followerId"
        ),
        users AS (
          SELECT id FROM "User" WHERE "bannedAt" IS NULL
        )
        SELECT
          AVG(COALESCE(follower_counts.followers, 0))::float AS avg_followers,
          COUNT(users.id)::bigint AS total_users,
          COUNT(
            CASE WHEN COALESCE(follower_counts.followers, 0) > 0
                  AND COALESCE(following_counts.following, 0) > 0
            THEN 1 END
          )::bigint AS connected_count
        FROM users
        LEFT JOIN follower_counts ON follower_counts.user_id = users.id
        LEFT JOIN following_counts ON following_counts.user_id = users.id
      `,

    // Monetization totals — single row, no GROUP BY.
    // Kept separate from the status breakdown so that FILTER counts apply to the
    // whole table, not per-group (which would give wrong numbers).
    //
    // "Paying" = premium=true backed by an active Stripe subscription.
    // "Comped"  = premium=true backed only by SubscriptionGrant records (no active Stripe sub).
    //             Uses a correlated EXISTS subquery so we count grant-backed premium accurately
    //             instead of inferring from the absence of a Stripe subscription.
    prisma.$queryRaw<
      Array<{
        free: bigint;
        paying_premium: bigint;
        paying_premium_plus: bigint;
        comped_premium: bigint;
        comped_premium_plus: bigint;
      }>
    >`
        SELECT
          COUNT(*) FILTER (
            WHERE "premium" = false AND "premiumPlus" = false
          )::bigint AS free,
          COUNT(*) FILTER (
            WHERE "premiumPlus" = false AND "premium" = true
              AND "stripeSubscriptionId" IS NOT NULL
              AND "stripeSubscriptionStatus" IN ('active', 'trialing', 'past_due')
          )::bigint AS paying_premium,
          COUNT(*) FILTER (
            WHERE "premiumPlus" = true
              AND "stripeSubscriptionId" IS NOT NULL
              AND "stripeSubscriptionStatus" IN ('active', 'trialing', 'past_due')
          )::bigint AS paying_premium_plus,
          COUNT(*) FILTER (
            WHERE "premiumPlus" = false AND "premium" = true
              AND ("stripeSubscriptionId" IS NULL
                OR "stripeSubscriptionStatus" NOT IN ('active', 'trialing', 'past_due'))
              AND EXISTS (
                SELECT 1 FROM "SubscriptionGrant" sg
                WHERE sg."userId" = "User"."id"
                  AND sg."tier" = 'premium'
                  AND sg."revokedAt" IS NULL
                  AND sg."endsAt" > ${now}::timestamptz
              )
          )::bigint AS comped_premium,
          COUNT(*) FILTER (
            WHERE "premiumPlus" = true
              AND ("stripeSubscriptionId" IS NULL
                OR "stripeSubscriptionStatus" NOT IN ('active', 'trialing', 'past_due'))
              AND EXISTS (
                SELECT 1 FROM "SubscriptionGrant" sg
                WHERE sg."userId" = "User"."id"
                  AND sg."tier" = 'premiumPlus'
                  AND sg."revokedAt" IS NULL
                  AND sg."endsAt" > ${now}::timestamptz
              )
          )::bigint AS comped_premium_plus
        FROM "User"
        WHERE "bannedAt" IS NULL
      `,

    // Stripe subscription status breakdown — separate query to avoid GROUP BY scoping issues above.
    prisma.$queryRaw<Array<{ stripe_status: string; cnt: bigint }>>`
        SELECT "stripeSubscriptionStatus" AS stripe_status, COUNT(*)::bigint AS cnt
        FROM "User"
        WHERE "bannedAt" IS NULL
          AND "stripeSubscriptionStatus" IS NOT NULL
        GROUP BY "stripeSubscriptionStatus"
        ORDER BY cnt DESC
      `,

    // Post visibility breakdown — regular posts only (non-draft, non-deleted), range-filtered.
    // onlyMe posts are excluded from the chart but tracked here so you can see them separately.
    prisma.$queryRaw<Array<{ visibility: string; cnt: bigint }>>(Prisma.sql`
        SELECT "visibility", COUNT(*)::bigint AS cnt
        FROM "Post"
        WHERE "deletedAt" IS NULL
          AND "isDraft" = false
          AND "kind" = 'regular'
        ${sinceAnd(Prisma.sql`"createdAt"`)}
        GROUP BY "visibility"
        ORDER BY cnt DESC
      `),

    // Top public regular posts by all-time denormalized view count.
    prisma.$queryRaw<
      Array<{
        id: string;
        body: string;
        author_username: string;
        unique_count: number;
        view_count: number;
        boost_count: number;
        comment_count: number;
        reaction_count: number;
        created_at: Date;
      }>
    >`
        SELECT
          p.id,
          p.body,
          u.username AS author_username,
          p."viewerCount" AS unique_count,
          p."totalViewCount" AS view_count,
          p."boostCount" AS boost_count,
          p."commentCount" AS comment_count,
          0 AS reaction_count,
          p."createdAt" AS created_at
        FROM "Post" p
        JOIN "User" u ON u.id = p."userId"
        WHERE p."deletedAt" IS NULL
          AND p."isDraft" = false
          AND p."kind" = 'regular'
          AND p."visibility" = 'public'
        GROUP BY p.id, u.username
        ORDER BY p."totalViewCount" DESC, p."createdAt" DESC
        LIMIT 10
      `,

    // ── Article queries ────────────────────────────────────────────────────

    // Article summary.
    // total_published / unique_authors are range-scoped via publishedAt.
    // total_drafts is always all-time (current pending state, not a time-series concept).
    prisma.$queryRaw<
      Array<{
        total_published: bigint;
        total_drafts: bigint;
        unique_authors: bigint;
      }>
    >(Prisma.sql`
        SELECT
          (SELECT COUNT(*)::bigint FROM "Article"
           WHERE "isDraft" = false AND "deletedAt" IS NULL AND "publishedAt" IS NOT NULL
           ${sinceAnd(Prisma.sql`"publishedAt"`)}) AS total_published,
          (SELECT COUNT(*)::bigint FROM "Article"
           WHERE "isDraft" = true AND "deletedAt" IS NULL) AS total_drafts,
          (SELECT COUNT(DISTINCT "authorId")::bigint FROM "Article"
           WHERE "isDraft" = false AND "deletedAt" IS NULL AND "publishedAt" IS NOT NULL
           ${sinceAnd(Prisma.sql`"publishedAt"`)}) AS unique_authors
      `),

    // Article visibility breakdown — published, non-deleted, range-filtered by publishedAt.
    prisma.$queryRaw<Array<{ visibility: string; cnt: bigint }>>(Prisma.sql`
        SELECT "visibility", COUNT(*)::bigint AS cnt
        FROM "Article"
        WHERE "isDraft" = false AND "deletedAt" IS NULL AND "publishedAt" IS NOT NULL
        ${sinceAnd(Prisma.sql`"publishedAt"`)}
        GROUP BY "visibility"
        ORDER BY cnt DESC
      `),

    // Articles published per bucket in the selected range.
    prisma.$queryRaw<Array<{ bucket: Date; count: bigint }>>(Prisma.sql`
        SELECT DATE_TRUNC(${granularity}, "publishedAt") AS bucket, COUNT(*)::bigint AS count
        FROM "Article"
        WHERE "isDraft" = false
          AND "deletedAt" IS NULL
          AND "publishedAt" IS NOT NULL
        ${sinceAnd(Prisma.sql`"publishedAt"`)}
        GROUP BY 1
        ORDER BY 1
      `),

    // Article views per bucket in the selected range.
    prisma.$queryRaw<Array<{ bucket: Date; count: bigint }>>(Prisma.sql`
        SELECT DATE_TRUNC(${granularity}, "createdAt") AS bucket, COUNT(*)::bigint AS count
        FROM "ArticleView"
        WHERE 1=1
        ${sinceAnd(Prisma.sql`"createdAt"`)}
        GROUP BY 1
        ORDER BY 1
      `),

    // Range-scoped article engagement totals.
    prisma.$queryRaw<
      Array<{
        unique_views: bigint;
        total_views: bigint;
        total_boosts: bigint;
        total_reactions: bigint;
        total_comments: bigint;
      }>
    >(Prisma.sql`
        SELECT
          (SELECT COUNT(*)::bigint FROM "ArticleView"
           WHERE 1=1 ${sinceAnd(Prisma.sql`"createdAt"`)}) AS unique_views,
          (SELECT COALESCE(SUM("impressionCount"), 0)::bigint FROM "ArticleView"
           WHERE 1=1 ${sinceAnd(Prisma.sql`"createdAt"`)}) AS total_views,
          (SELECT COUNT(*)::bigint FROM "ArticleBoost"
           WHERE 1=1 ${sinceAnd(Prisma.sql`"createdAt"`)}) AS total_boosts,
          (SELECT COUNT(*)::bigint FROM "ArticleReaction"
           WHERE 1=1 ${sinceAnd(Prisma.sql`"createdAt"`)}) AS total_reactions,
          (SELECT COUNT(*)::bigint FROM "ArticleComment"
           WHERE "deletedAt" IS NULL ${sinceAnd(Prisma.sql`"createdAt"`)}) AS total_comments
      `),

    // Total coins across all non-banned users — all-time economy total.
    prisma.$queryRaw<Array<{ total_coins: bigint }>>`
        SELECT COALESCE(SUM("coins"), 0)::bigint AS total_coins
        FROM "User"
        WHERE "bannedAt" IS NULL
      `,

    // Top 10 articles by view count in the range.
    prisma.$queryRaw<
      Array<{
        id: string;
        title: string;
        slug: string;
        visibility: string;
        author_username: string;
        unique_count: bigint;
        view_count: bigint;
        boost_count: bigint;
        comment_count: bigint;
        reaction_count: bigint;
        published_at: Date;
      }>
    >(Prisma.sql`
        SELECT
          a.id,
          a.title,
          a.slug,
          a.visibility,
          u.username AS author_username,
          COUNT(av."userId")::bigint AS unique_count,
          COALESCE(SUM(av."impressionCount"), 0)::bigint AS view_count,
          (SELECT COUNT(*)::bigint FROM "ArticleBoost" ab
           WHERE ab."articleId" = a.id
           ${since ? Prisma.sql`AND ab."createdAt" >= ${since}::timestamptz` : Prisma.sql``}) AS boost_count,
          (SELECT COUNT(*)::bigint FROM "ArticleComment" ac
           WHERE ac."articleId" = a.id AND ac."deletedAt" IS NULL
           ${since ? Prisma.sql`AND ac."createdAt" >= ${since}::timestamptz` : Prisma.sql``}) AS comment_count,
          (SELECT COUNT(*)::bigint FROM "ArticleReaction" ar
           WHERE ar."articleId" = a.id
           ${since ? Prisma.sql`AND ar."createdAt" >= ${since}::timestamptz` : Prisma.sql``}) AS reaction_count,
          a."publishedAt" AS published_at
        FROM "Article" a
        JOIN "User" u ON u.id = a."authorId"
        LEFT JOIN "ArticleView" av ON av."articleId" = a.id
          ${since ? Prisma.sql`AND av."createdAt" >= ${since}::timestamptz` : Prisma.sql``}
        WHERE a."isDraft" = false
          AND a."deletedAt" IS NULL
          AND a."publishedAt" IS NOT NULL
        GROUP BY a.id, u.username
        ORDER BY view_count DESC
        LIMIT 10
      `),

    // ── Coin queries ────────────────────────────────────────────────────────

    // Coins minted from streak rewards in the selected range.
    prisma.$queryRaw<
      Array<{ minted_total: bigint; unique_earners: bigint }>
    >(Prisma.sql`
        SELECT
          COALESCE(SUM(amount), 0)::bigint AS minted_total,
          COUNT(DISTINCT "senderId")::bigint AS unique_earners
        FROM "CoinTransfer"
        WHERE kind = 'streak_reward'
        ${sinceAnd(Prisma.sql`"createdAt"`)}
      `),

    // Coins sent peer-to-peer in the selected range.
    prisma.$queryRaw<
      Array<{ transferred_total: bigint; unique_senders: bigint }>
    >(Prisma.sql`
        SELECT
          COALESCE(SUM(amount), 0)::bigint AS transferred_total,
          COUNT(DISTINCT "senderId")::bigint AS unique_senders
        FROM "CoinTransfer"
        WHERE kind = 'transfer'
        ${sinceAnd(Prisma.sql`"createdAt"`)}
      `),

    // Time series: coins minted from streaks per time bucket.
    prisma.$queryRaw<Array<{ bucket: Date; count: bigint }>>(Prisma.sql`
        SELECT DATE_TRUNC(${granularity}, "createdAt") AS bucket, SUM(amount)::bigint AS count
        FROM "CoinTransfer"
        WHERE kind = 'streak_reward'
        ${sinceAnd(Prisma.sql`"createdAt"`)}
        GROUP BY 1
        ORDER BY 1
      `),

    // Coins minted grouped by multiplier amount (amount = 1, 2, 3, or 4).
    prisma.$queryRaw<Array<{ amount: number; cnt: bigint }>>(Prisma.sql`
        SELECT amount, COUNT(*)::bigint AS cnt
        FROM "CoinTransfer"
        WHERE kind = 'streak_reward'
        ${sinceAnd(Prisma.sql`"createdAt"`)}
        GROUP BY amount
        ORDER BY amount
      `),

    // Gini coefficient of the coin distribution (all non-banned users with coins > 0).
    // Formula: G = (2 * Σ(rank_i * coins_i) / (n * Σcoins_i)) - (n + 1) / n
    prisma.$queryRaw<Array<{ gini: number | null }>>`
        WITH ranked AS (
          SELECT coins,
                 ROW_NUMBER() OVER (ORDER BY coins) AS rank,
                 COUNT(*) OVER () AS n,
                 SUM(coins) OVER () AS total_coins
          FROM "User"
          WHERE "bannedAt" IS NULL AND coins > 0
        )
        SELECT
          CASE
            WHEN MAX(n) = 0 OR MAX(total_coins) = 0 THEN 0
            ELSE ROUND(
              (2.0 * SUM(rank * coins) / (MAX(n)::numeric * MAX(total_coins)::numeric)
               - (MAX(n)::numeric + 1) / MAX(n)::numeric)::numeric,
              4
            )
          END AS gini
        FROM ranked
      `,
  ]);

  const [
    groupUsersInAnyRow,
    groupActiveGroupsRow,
    groupNewMembershipsRow,
    groupPendingRow,
    groupRootsRow,
    groupRepliesRow,
    groupReplyRateRow,
    groupTopRaw,
  ] = await Promise.all([
    prisma.$queryRaw<Array<{ cnt: bigint }>>`
        SELECT COUNT(DISTINCT m."userId")::bigint AS cnt
        FROM "CommunityGroupMember" m
        JOIN "User" u ON u.id = m."userId"
        WHERE m.status = 'active'
          AND u."bannedAt" IS NULL
      `,
    prisma.$queryRaw<Array<{ cnt: bigint }>>`
        SELECT COUNT(*)::bigint AS cnt
        FROM "CommunityGroup"
        WHERE "deletedAt" IS NULL
      `,
    prisma.$queryRaw<Array<{ cnt: bigint }>>(Prisma.sql`
        SELECT COUNT(*)::bigint AS cnt
        FROM "CommunityGroupMember" m
        JOIN "CommunityGroup" g ON g.id = m."groupId"
        WHERE m.status = 'active'
          AND g."deletedAt" IS NULL
        ${sinceAnd(Prisma.sql`m."createdAt"`)}
      `),
    prisma.$queryRaw<Array<{ cnt: bigint }>>`
        SELECT COUNT(*)::bigint AS cnt
        FROM "CommunityGroupMember" m
        JOIN "CommunityGroup" g ON g.id = m."groupId"
        WHERE m.status = 'pending'
          AND g."deletedAt" IS NULL
      `,
    prisma.$queryRaw<Array<{ cnt: bigint }>>(Prisma.sql`
        SELECT COUNT(*)::bigint AS cnt
        FROM "Post"
        WHERE "deletedAt" IS NULL
          AND "isDraft" = false
          AND "communityGroupId" IS NOT NULL
          AND "parentId" IS NULL
        ${sinceAnd(Prisma.sql`"createdAt"`)}
      `),
    prisma.$queryRaw<Array<{ cnt: bigint }>>(Prisma.sql`
        SELECT COUNT(*)::bigint AS cnt
        FROM "Post"
        WHERE "deletedAt" IS NULL
          AND "isDraft" = false
          AND "communityGroupId" IS NOT NULL
          AND "parentId" IS NOT NULL
        ${sinceAnd(Prisma.sql`"createdAt"`)}
      `),
    prisma.$queryRaw<
      Array<{ total_roots: bigint; with_reply_24h: bigint }>
    >(Prisma.sql`
        WITH roots AS (
          SELECT id, "createdAt"
          FROM "Post"
          WHERE "deletedAt" IS NULL
            AND "isDraft" = false
            AND "communityGroupId" IS NOT NULL
            AND "parentId" IS NULL
          ${sinceAnd(Prisma.sql`"createdAt"`)}
        )
        SELECT
          COUNT(*)::bigint AS total_roots,
          COUNT(*) FILTER (WHERE EXISTS (
            SELECT 1
            FROM "Post" c
            WHERE c."deletedAt" IS NULL
              AND c."rootId" = roots.id
              AND c.id <> roots.id
              AND c."createdAt" <= roots."createdAt" + INTERVAL '24 hours'
          ))::bigint AS with_reply_24h
        FROM roots
      `),
    prisma.$queryRaw<
      Array<{
        id: string;
        slug: string;
        name: string;
        member_count: number;
        root_posts_in_range: bigint;
        roots_with_reply_24h: bigint;
      }>
    >(Prisma.sql`
        WITH roots_in_range AS (
          SELECT "communityGroupId" AS gid, id, "createdAt"
          FROM "Post"
          WHERE "deletedAt" IS NULL
            AND "isDraft" = false
            AND "communityGroupId" IS NOT NULL
            AND "parentId" IS NULL
          ${sinceAnd(Prisma.sql`"createdAt"`)}
        ),
        per_group AS (
          SELECT
            r.gid,
            COUNT(*)::bigint AS root_cnt,
            COUNT(*) FILTER (WHERE EXISTS (
              SELECT 1
              FROM "Post" c
              WHERE c."deletedAt" IS NULL
                AND c."rootId" = r.id
                AND c.id <> r.id
                AND c."createdAt" <= r."createdAt" + INTERVAL '24 hours'
            ))::bigint AS answered_cnt
          FROM roots_in_range r
          GROUP BY r.gid
        )
        SELECT
          g.id,
          g.slug,
          g.name,
          g."memberCount" AS member_count,
          COALESCE(p.root_cnt, 0)::bigint AS root_posts_in_range,
          COALESCE(p.answered_cnt, 0)::bigint AS roots_with_reply_24h
        FROM "CommunityGroup" g
        LEFT JOIN per_group p ON p.gid = g.id
        WHERE g."deletedAt" IS NULL
        ORDER BY COALESCE(p.root_cnt, 0) DESC, g."memberCount" DESC, g.name ASC
        LIMIT 12
      `),
  ]);

  return assembleAdminAnalytics({
    prisma,
    landing,
    sinceAnd,
    now,
    since,
    granularity,
    rangeParam,
    summaryRow,
    publicPostsSummaryRow,
    activeGrantsCountRow,
    dauMauRow,
    signupsRaw,
    userPostsRaw,
    aiPostsRaw,
    checkinsRaw,
    userMessagesRaw,
    aiMessagesRaw,
    followsRaw,
    retentionRaw,
    d30Raw,
    activationRaw,
    creatorRaw,
    networkRaw,
    monetizationTotalsRaw,
    monetizationByStatusRaw,
    postVisibilityRaw,
    topPostsAllTimeRaw,
    articleSummaryRaw,
    articleVisibilityRaw,
    articlePublishedRaw,
    articleViewsRaw,
    articleEngagementRaw,
    totalCoinsRow,
    articleTopRaw,
    coinsMintedSummaryRaw,
    coinsTransferredSummaryRaw,
    coinsMintedSeriesRaw,
    coinsMintedByMultiplierRaw,
    coinsGiniRaw,
    groupUsersInAnyRow,
    groupActiveGroupsRow,
    groupNewMembershipsRow,
    groupPendingRow,
    groupRootsRow,
    groupRepliesRow,
    groupReplyRateRow,
    groupTopRaw,
  });
}
