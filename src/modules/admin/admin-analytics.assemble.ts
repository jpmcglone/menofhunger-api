import { Prisma } from "@prisma/client";
import { PrismaService } from "../prisma/prisma.service";
import { LandingService } from "../landing/landing.service";
import { readBoardAnalytics } from "./admin-analytics-board.read";
import { readChannelsAnalytics } from "./admin-analytics-channels.read";
import type { AdminAnalyticsArticlesDto, AdminAnalyticsCoinsDto, AdminAnalyticsDto, AdminAnalyticsEngagementDto, AdminAnalyticsGroupsDto, AdminAnalyticsSpacesDto, AnalyticsGranularity, AnalyticsRange } from "../../common/dto/admin-analytics.dto";
function toTimeSeries(rows: Array<{ bucket: Date; count: bigint }>) {
  return rows.map((r) => ({
    bucket: r.bucket.toISOString().split("T")[0]!,
    count: Number(r.count),
  }));
}

export async function assembleAdminAnalytics(ctx: {
  prisma: PrismaService;
  landing: LandingService;
  sinceAnd: (col: Prisma.Sql) => Prisma.Sql;
  now: Date;
  since: Date | null;
  granularity: AnalyticsGranularity;
  rangeParam?: string;
  [key: string]: unknown;
}) {
  const prisma = ctx.prisma;
  const landing = ctx.landing;
  const sinceAnd = ctx.sinceAnd;
  const now = ctx.now;
  const since = ctx.since;
  const granularity = ctx.granularity;
  const rangeParam = ctx.rangeParam;
  const {
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
  } = ctx as any;

  // ── Spaces queries ────────────────────────────────────────────────────────

  const [
    spaceSummaryRaw,
    spaceByModeRaw,
    spaceCreatedSeriesRaw,
    spaceTopRaw,
    spaceSubscribersRaw,
  ] = await Promise.all([
    // Summary counts: total, active, created / went live in range, scheduled.
    prisma.$queryRaw<
      Array<{
        total_spaces: bigint;
        active_spaces: bigint;
        created_in_range: bigint;
        went_live_in_range: bigint;
        scheduled_spaces: bigint;
      }>
    >(Prisma.sql`
        SELECT
          COUNT(*)::bigint AS total_spaces,
          COUNT(*) FILTER (WHERE "isActive" = true)::bigint AS active_spaces,
          COUNT(*) FILTER (WHERE "createdAt" >= ${since ?? new Date(0)}::timestamptz)::bigint AS created_in_range,
          COUNT(*) FILTER (WHERE "activatedAt" IS NOT NULL AND "activatedAt" >= ${since ?? new Date(0)}::timestamptz)::bigint AS went_live_in_range,
          COUNT(*) FILTER (WHERE "isActive" = false AND "scheduledAt" IS NOT NULL AND "scheduledAt" > NOW())::bigint AS scheduled_spaces
        FROM "Space"
      `),

    // All-time mode breakdown (current state of all spaces).
    prisma.$queryRaw<Array<{ mode: string; cnt: bigint }>>`
        SELECT mode, COUNT(*)::bigint AS cnt
        FROM "Space"
        GROUP BY mode
        ORDER BY cnt DESC
      `,

    // Time series: spaces created per bucket in the selected range.
    prisma.$queryRaw<Array<{ bucket: Date; count: bigint }>>(Prisma.sql`
        SELECT DATE_TRUNC(${granularity}, "createdAt") AS bucket, COUNT(*)::bigint AS count
        FROM "Space"
        WHERE 1=1
        ${sinceAnd(Prisma.sql`"createdAt"`)}
        GROUP BY 1
        ORDER BY 1
      `),

    // Currently active spaces, most recently updated, with owner info.
    prisma.$queryRaw<
      Array<{
        id: string;
        owner_id: string;
        owner_username: string | null;
        title: string;
        mode: string;
        is_active: boolean;
        created_at: Date;
        activated_at: Date | null;
      }>
    >`
        SELECT
          s.id,
          s."ownerId" AS owner_id,
          u.username AS owner_username,
          s.title,
          s.mode,
          s."isActive" AS is_active,
          s."createdAt" AS created_at,
          s."activatedAt" AS activated_at
        FROM "Space" s
        JOIN "User" u ON u.id = s."ownerId"
        WHERE s."isActive" = true
        ORDER BY s."updatedAt" DESC
        LIMIT 20
      `,

    prisma.$queryRaw<
      Array<{ total_subscribers: bigint; subscribers_in_range: bigint }>
    >(Prisma.sql`
        SELECT
          COUNT(*) FILTER (WHERE sss."userId" <> s."ownerId")::bigint AS total_subscribers,
          COUNT(*) FILTER (
            WHERE sss."userId" <> s."ownerId"
              AND sss."createdAt" >= ${since ?? new Date(0)}::timestamptz
          )::bigint AS subscribers_in_range
        FROM "SpaceScheduleSubscriber" sss
        JOIN "Space" s ON s.id = sss."spaceId"
      `),
  ]);

  // ── Marvin / AI queries ───────────────────────────────────────────────────

  const [
    marvSummaryRaw,
    marvBySourceRaw,
    marvByModeRaw,
    marvByOutcomeRaw,
    marvInteractionsRaw,
  ] = await Promise.all([
    // Single-row summary of all Marv interactions in range.
    prisma.$queryRaw<
      Array<{
        total_interactions: bigint;
        successful_interactions: bigint;
        unique_users: bigint;
        credits_spent: number;
        estimated_cost_usd: string | null;
        avg_latency_ms: number | null;
      }>
    >(Prisma.sql`
        SELECT
          COUNT(*)::bigint AS total_interactions,
          COUNT(*) FILTER (WHERE "errorCode" IS NULL)::bigint AS successful_interactions,
          COUNT(DISTINCT "userId")::bigint AS unique_users,
          COALESCE(SUM("creditsSpent"), 0)::float AS credits_spent,
          SUM("estimatedCostUsd")::text AS estimated_cost_usd,
          AVG("latencyMs") FILTER (WHERE "errorCode" IS NULL)::float AS avg_latency_ms
        FROM "MarvinUsageEvent"
        WHERE 1=1
        ${sinceAnd(Prisma.sql`"createdAt"`)}
      `),

    // Breakdown by source (public_thread | private_session).
    prisma.$queryRaw<Array<{ source: string; cnt: bigint }>>(Prisma.sql`
        SELECT source::text, COUNT(*)::bigint AS cnt
        FROM "MarvinUsageEvent"
        WHERE 1=1
        ${sinceAnd(Prisma.sql`"createdAt"`)}
        GROUP BY source
        ORDER BY cnt DESC
      `),

    // Breakdown by effectiveMode for successful interactions only.
    prisma.$queryRaw<Array<{ mode: string; cnt: bigint }>>(Prisma.sql`
        SELECT "effectiveMode"::text AS mode, COUNT(*)::bigint AS cnt
        FROM "MarvinUsageEvent"
        WHERE "errorCode" IS NULL
        ${sinceAnd(Prisma.sql`"createdAt"`)}
        GROUP BY "effectiveMode"
        ORDER BY cnt DESC
      `),

    // Breakdown by outcome: NULL errorCode → 'success', else the errorCode string.
    prisma.$queryRaw<Array<{ outcome: string; cnt: bigint }>>(Prisma.sql`
        SELECT COALESCE("errorCode", 'success') AS outcome, COUNT(*)::bigint AS cnt
        FROM "MarvinUsageEvent"
        WHERE 1=1
        ${sinceAnd(Prisma.sql`"createdAt"`)}
        GROUP BY outcome
        ORDER BY cnt DESC
      `),

    // Time series of successful interactions per granularity bucket.
    prisma.$queryRaw<Array<{ bucket: Date; count: bigint }>>(Prisma.sql`
        SELECT DATE_TRUNC(${granularity}, "createdAt") AS bucket, COUNT(*)::bigint AS count
        FROM "MarvinUsageEvent"
        WHERE "errorCode" IS NULL
        ${sinceAnd(Prisma.sql`"createdAt"`)}
        GROUP BY 1
        ORDER BY 1
      `),
  ]);

  const marvSummary = marvSummaryRaw[0];
  const estimatedCostUsd =
    marvSummary?.estimated_cost_usd != null
      ? Number(marvSummary.estimated_cost_usd)
      : null;
  const aiBlock = {
    totalInteractionsInRange: Number(marvSummary?.total_interactions ?? 0),
    successfulInteractionsInRange: Number(
      marvSummary?.successful_interactions ?? 0,
    ),
    uniqueUsersInRange: Number(marvSummary?.unique_users ?? 0),
    creditsSpentInRange: Number(marvSummary?.credits_spent ?? 0),
    estimatedCostUsdInRange: estimatedCostUsd,
    avgLatencyMsInRange:
      marvSummary?.avg_latency_ms != null
        ? Math.round(Number(marvSummary.avg_latency_ms))
        : null,
    bySource: Object.fromEntries(
      marvBySourceRaw.map((r) => [r.source, Number(r.cnt)]),
    ),
    byEffectiveMode: Object.fromEntries(
      marvByModeRaw.map((r) => [r.mode, Number(r.cnt)]),
    ),
    byOutcome: Object.fromEntries(
      marvByOutcomeRaw.map((r) => [r.outcome, Number(r.cnt)]),
    ),
    interactions: toTimeSeries(marvInteractionsRaw),
  };

  const spaceSummary = spaceSummaryRaw[0];
  const spaceSubscribers = spaceSubscribersRaw[0];
  const spacesBlock: AdminAnalyticsSpacesDto = {
    totalSpaces: Number(spaceSummary?.total_spaces ?? 0),
    activeSpaces: Number(spaceSummary?.active_spaces ?? 0),
    spacesCreatedInRange: Number(spaceSummary?.created_in_range ?? 0),
    wentLiveInRange: Number(spaceSummary?.went_live_in_range ?? 0),
    scheduledSpaces: Number(spaceSummary?.scheduled_spaces ?? 0),
    notifyMeSubscribers: Number(spaceSubscribers?.total_subscribers ?? 0),
    notifyMeSubscribersInRange: Number(
      spaceSubscribers?.subscribers_in_range ?? 0,
    ),
    byMode: Object.fromEntries(
      spaceByModeRaw.map((r) => [r.mode, Number(r.cnt)]),
    ),
    created: toTimeSeries(spaceCreatedSeriesRaw),
    topSpaces: spaceTopRaw.map((r) => ({
      id: r.id,
      ownerId: r.owner_id,
      ownerUsername: r.owner_username ?? "",
      title: r.title,
      mode: r.mode,
      isActive: r.is_active,
      createdAt: r.created_at.toISOString(),
      activatedAt: r.activated_at ? r.activated_at.toISOString() : null,
    })),
  };

  const usersInAnyGroup = Number(groupUsersInAnyRow[0]?.cnt ?? 0);
  const totalUsersForPct = Number(summaryRow[0]?.total_users ?? 0);
  const groupsBlock: AdminAnalyticsGroupsDto = {
    usersInAnyGroup,
    pctUsersInAnyGroup:
      totalUsersForPct > 0
        ? Math.round((usersInAnyGroup / totalUsersForPct) * 1000) / 10
        : null,
    activeGroups: Number(groupActiveGroupsRow[0]?.cnt ?? 0),
    newActiveMembershipsInRange: Number(groupNewMembershipsRow[0]?.cnt ?? 0),
    pendingApprovals: Number(groupPendingRow[0]?.cnt ?? 0),
    groupRootPostsInRange: Number(groupRootsRow[0]?.cnt ?? 0),
    groupRepliesInRange: Number(groupRepliesRow[0]?.cnt ?? 0),
    pctGroupRootsWithReplyWithin24h: (() => {
      const tr = Number(groupReplyRateRow[0]?.total_roots ?? 0);
      const wr = Number(groupReplyRateRow[0]?.with_reply_24h ?? 0);
      if (tr <= 0) return null;
      return Math.round((wr / tr) * 1000) / 10;
    })(),
    topGroups: groupTopRaw.map((r: any) => {
      const roots = Number(r.root_posts_in_range ?? 0);
      const answered = Number(r.roots_with_reply_24h ?? 0);
      return {
        id: r.id,
        slug: r.slug,
        name: r.name,
        memberCount: r.member_count,
        rootPostsInRange: roots,
        replyRate24hPct:
          roots > 0 ? Math.round((answered / roots) * 1000) / 10 : null,
      };
    }),
  };

  // ── Summary ───────────────────────────────────────────────────────────────

  const summary = summaryRow[0];
  const totalPublicPosts = Number(publicPostsSummaryRow[0]?.cnt ?? 0);
  const activeGrantsCount = Number(activeGrantsCountRow[0]?.cnt ?? 0);
  const dauMau = dauMauRow[0];

  // ── Monetization ──────────────────────────────────────────────────────────

  const totals = monetizationTotalsRaw[0];
  const free = Number(totals?.free ?? 0);
  const payingPremium = Number(totals?.paying_premium ?? 0);
  const payingPremiumPlus = Number(totals?.paying_premium_plus ?? 0);
  const compedPremium = Number(totals?.comped_premium ?? 0);
  const compedPremiumPlus = Number(totals?.comped_premium_plus ?? 0);

  const byStatus = Object.fromEntries(
    monetizationByStatusRaw.map((r: any) => [r.stripe_status, Number(r.cnt)]),
  );
  const postsByVisibility = Object.fromEntries(
    postVisibilityRaw.map((r: any) => [r.visibility, Number(r.cnt)]),
  );

  // ── Engagement ────────────────────────────────────────────────────────────

  const d30 = d30Raw[0];
  const activation = activationRaw[0];
  const creator = creatorRaw[0];
  const network = networkRaw[0];

  const d30CohortSize = Number(d30?.cohort_size ?? 0);
  const d30RetainedCount = Number(d30?.retained_count ?? 0);
  const activationEligibleCount = Number(activation?.eligible_count ?? 0);
  const activationCount = Number(activation?.activated_count ?? 0);
  const creatorMauCount = Number(creator?.mau_count ?? 0);
  const creatorCount = Number(creator?.creator_count ?? 0);
  const totalUsers = Number(network?.total_users ?? 0);
  const connectedCount = Number(network?.connected_count ?? 0);

  const engagement: AdminAnalyticsEngagementDto = {
    d30CohortSize,
    d30RetainedCount,
    d30RetentionPct:
      d30CohortSize > 0
        ? Math.round((d30RetainedCount / d30CohortSize) * 100)
        : null,
    activationEligibleCount,
    activationCount,
    activationPct:
      activationEligibleCount > 0
        ? Math.round((activationCount / activationEligibleCount) * 100)
        : null,
    creatorMauCount,
    creatorCount,
    creatorPct:
      creatorMauCount > 0
        ? Math.round((creatorCount / creatorMauCount) * 100)
        : null,
    avgFollowersPerUser:
      Math.round(Number(network?.avg_followers ?? 0) * 10) / 10,
    connectedUserCount: connectedCount,
    connectedUserPct:
      totalUsers > 0 ? Math.round((connectedCount / totalUsers) * 100) : null,
  };

  const topPostsAllTime = topPostsAllTimeRaw.map((r: any) => ({
    id: r.id,
    bodyPreview:
      r.body.length > 180 ? `${r.body.slice(0, 180).trimEnd()}...` : r.body,
    authorUsername: r.author_username,
    uniqueViewCount: Number(r.unique_count),
    viewCount: Math.max(Number(r.unique_count), Number(r.view_count)),
    boostCount: Number(r.boost_count),
    commentCount: Number(r.comment_count),
    reactionCount: Number(r.reaction_count),
    createdAt: r.created_at.toISOString(),
  }));

  // ── Articles ──────────────────────────────────────────────────────────────

  const artSummary = articleSummaryRaw[0];
  const totalPublished = Number(artSummary?.total_published ?? 0);
  const totalDrafts = Number(artSummary?.total_drafts ?? 0);
  const uniqueAuthors = Number(artSummary?.unique_authors ?? 0);

  const artEngagement = articleEngagementRaw[0];
  const uniqueViewsInRange = Number(artEngagement?.unique_views ?? 0);
  const totalViewsInRange = Math.max(
    uniqueViewsInRange,
    Number(artEngagement?.total_views ?? 0),
  );
  const totalBoostsInRange = Number(artEngagement?.total_boosts ?? 0);
  const totalReactionsInRange = Number(artEngagement?.total_reactions ?? 0);
  const totalCommentsInRange = Number(artEngagement?.total_comments ?? 0);

  // avg views per article that was published in the range
  const articlesPublishedInRange = articlePublishedRaw.reduce(
    (s: any, r: any) => s + Number(r.count),
    0,
  );
  const avgViewsPerArticle =
    articlesPublishedInRange > 0
      ? Math.round((uniqueViewsInRange / articlesPublishedInRange) * 10) / 10
      : 0;

  const articles: AdminAnalyticsArticlesDto = {
    kpis: {
      totalPublished,
      totalDrafts,
      uniqueAuthors,
      uniqueViewsInRange,
      totalViewsInRange,
      totalBoostsInRange,
      totalReactionsInRange,
      totalCommentsInRange,
      avgViewsPerArticle,
    },
    published: toTimeSeries(articlePublishedRaw),
    views: toTimeSeries(articleViewsRaw),
    byVisibility: Object.fromEntries(
      articleVisibilityRaw.map((r: any) => [r.visibility, Number(r.cnt)]),
    ),
    topArticles: articleTopRaw
      .filter((r: any) => r.published_at != null)
      .map((r: any) => ({
        id: r.id,
        title: r.title,
        slug: r.slug,
        visibility: r.visibility,
        authorUsername: r.author_username,
        uniqueViewCount: Number(r.unique_count),
        viewCount: Math.max(Number(r.unique_count), Number(r.view_count)),
        boostCount: Number(r.boost_count),
        commentCount: Number(r.comment_count),
        reactionCount: Number(r.reaction_count),
        publishedAt: r.published_at!.toISOString(),
      })),
  };

  // ── Coins ─────────────────────────────────────────────────────────────────

  const coinsMintedSummary = coinsMintedSummaryRaw[0];
  const coinsTransferredSummary = coinsTransferredSummaryRaw[0];

  const mintedInRange = Number(coinsMintedSummary?.minted_total ?? 0);
  const transferredInRange = Number(
    coinsTransferredSummary?.transferred_total ?? 0,
  );
  const velocityRatio =
    mintedInRange > 0
      ? Math.round((transferredInRange / mintedInRange) * 1000) / 1000
      : null;

  const coins: AdminAnalyticsCoinsDto = {
    totalInEconomy: Number(totalCoinsRow[0]?.total_coins ?? 0),
    mintedInRange,
    transferredInRange,
    uniqueEarnersInRange: Number(coinsMintedSummary?.unique_earners ?? 0),
    uniqueSendersInRange: Number(coinsTransferredSummary?.unique_senders ?? 0),
    minted: toTimeSeries(coinsMintedSeriesRaw),
    mintedByMultiplier: Object.fromEntries(
      coinsMintedByMultiplierRaw.map((r: any) => [String(r.amount), Number(r.cnt)]),
    ),
    velocityRatio,
    giniCoefficient:
      coinsGiniRaw[0]?.gini != null ? Number(coinsGiniRaw[0].gini) : null,
  };

  // Same all-time landing stats shown on the public homepage (cached ~60s).
  const [landingSnapshot, board, channels] = await Promise.all([
    landing.getSnapshot(now),
    readBoardAnalytics(prisma, { since, granularity }),
    readChannelsAnalytics(prisma, { since, granularity }),
  ]);

  // ── Response ──────────────────────────────────────────────────────────────

  const data: AdminAnalyticsDto = {
    range: (rangeParam as AnalyticsRange) || "30d",
    granularity,
    summary: {
      totalUsers: Number(summary?.total_users ?? 0),
      verifiedUsers: Number(summary?.verified_users ?? 0),
      totalPublicPosts,
      // premiumUsers includes ALL paid tiers (premium-only + premiumPlus),
      // because billing sets premium=true for both. Don't add premiumPlusUsers to it.
      premiumUsers: Number(summary?.premium_users ?? 0),
      premiumPlusUsers: Number(summary?.premium_plus_users ?? 0),
      usersWithActiveGrants: activeGrantsCount,
      dau: Math.round(Number(dauMau?.dau ?? 0)),
      mau: Number(dauMau?.mau ?? 0),
      totalCoinsInEconomy: coins.totalInEconomy,
    },
    signups: toTimeSeries(signupsRaw),
    topPostsAllTime,
    postsByVisibility,
    posts: toTimeSeries(userPostsRaw),
    aiPosts: toTimeSeries(aiPostsRaw),
    checkins: toTimeSeries(checkinsRaw),
    messages: toTimeSeries(userMessagesRaw),
    aiMessages: toTimeSeries(aiMessagesRaw),
    follows: toTimeSeries(followsRaw),
    retention: retentionRaw.map((r: any) => ({
      cohortWeek: r.cohort_week.toISOString().split("T")[0],
      size: Number(r.size),
      w1: Number(r.retained_w1),
      w4: Number(r.retained_w4),
    })),
    engagement,
    landing: landingSnapshot.stats,
    monetization: {
      free,
      payingPremium,
      payingPremiumPlus,
      compedPremium,
      compedPremiumPlus,
      byStatus,
    },
    coins,
    articles,
    board,
    groups: groupsBlock,
    channels,
    spaces: spacesBlock,
    ai: aiBlock,
    asOf: now.toISOString(),
  };

  return { data };
}
