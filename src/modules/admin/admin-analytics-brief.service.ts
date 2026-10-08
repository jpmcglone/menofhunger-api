import { Injectable, Logger, ServiceUnavailableException } from '@nestjs/common';
import type { AnalyticsRange } from '../../common/dto/admin-analytics.dto';
import { MarvinAIService, MarvinAINotConfiguredError } from '../marvin/services/marvin-ai.service';

export type AdminAnalyticsBriefInput = {
  range: AnalyticsRange;
  analytics: Record<string, unknown>;
  referrals?: Record<string, unknown> | null;
};

const RANGE_DAYS: Record<AnalyticsRange, number | null> = {
  '7d': 7,
  '30d': 30,
  '3m': 90,
  '1y': 365,
  all: null,
};

@Injectable()
export class AdminAnalyticsBriefService {
  private readonly logger = new Logger(AdminAnalyticsBriefService.name);

  constructor(private readonly ai: MarvinAIService) {}

  async brief(adminUserId: string, input: AdminAnalyticsBriefInput): Promise<{ brief: string }> {
    if (!this.ai.isConfigured()) {
      throw new ServiceUnavailableException('Marv is not configured on this server.');
    }

    const snapshot = rangeDigest(input);
    const period = snapshot.selectedRange;
    const developerNote = [
      'You are briefing a Men of Hunger administrator on the analytics range they selected.',
      `The selected scope is ${period.label}${period.startDate ? `, ${period.startDate} through ${period.endDate}` : `, through ${period.endDate}`}.`,
      'Brief only selectedRange. That object already sums the full loaded range, including channel messages and group feed posts.',
      'notTheSelectedRange holds other windows. MAU, creator share, and 30-day retention are always the last 30 days. Activation is lifetime. Paying subscribers, total users, and referrals are the current or all-time snapshot.',
      'If you mention a figure from notTheSelectedRange, name its window. Do not call the selected range "this month" unless the range is 30d.',
      'A group is active in this scope only when it is listed under groupsWithFeedPosts or channels.groupsByChannelMessages. A group that is missing had no feed posts and no listed channel messages in this scope. Do not call it active from memory.',
      'Include channel conversation, not only the group feed.',
      'Do not use tools. Do not invent numbers.',
      'Write a short plain briefing: what is healthy, what is weak, and what to watch. A few short paragraphs. No markdown headings.',
    ].join(' ');

    let result;
    try {
      result = await this.ai.respond({
        source: 'admin_console',
        mode: 'regular',
        developerNote,
        userMessage: JSON.stringify(snapshot),
        dispatchTool: async () => 'Tools are disabled for this admin briefing. Use only the JSON.',
        toolContext: { requesterUserId: adminUserId },
        cacheKey: `admin:analytics-brief:v2:${input.range}`,
      });
    } catch (err) {
      if (err instanceof MarvinAINotConfiguredError) {
        throw new ServiceUnavailableException('Marv is not configured on this server.');
      }
      this.logger.error(
        `[admin-analytics-brief] AI call failed: ${err instanceof Error ? err.message : String(err)}`,
      );
      throw new ServiceUnavailableException('Marv could not read these numbers right now. Try again.');
    }

    const brief = MarvinAIService.cleanReplyText(result.text ?? '').trim();
    if (!brief) {
      throw new ServiceUnavailableException('Marv could not read these numbers right now. Try again.');
    }
    return { brief };
  }
}

function rangeDigest(input: AdminAnalyticsBriefInput) {
  const analytics = input.analytics;
  const summary = asRecord(analytics.summary);
  const engagement = asRecord(analytics.engagement);
  const groups = asRecord(analytics.groups);
  const channels = asRecord(analytics.channels);
  const board = asRecord(analytics.board);
  const coins = asRecord(analytics.coins);
  const articles = asRecord(analytics.articles);
  const monetization = asRecord(analytics.monetization);
  const asOf = typeof analytics.asOf === 'string' ? analytics.asOf : null;

  return {
    selectedRange: {
      ...periodFor(input.range, asOf),
      averageDailyActiveUsers: num(summary?.dau),
      signups: sumSeries(analytics.signups),
      posts: sumSeries(analytics.posts),
      checkins: sumSeries(analytics.checkins),
      directMessages: sumSeries(analytics.messages),
      follows: sumSeries(analytics.follows),
      articlesPublished: sumSeries(articles?.published),
      coinsMinted: num(coins?.mintedInRange),
      coinsTransferred: num(coins?.transferredInRange),
      boardThreads: num(board?.threadsInRange),
      boardComments: num(board?.commentsInRange),
      groups: feedGroups(groups),
      channels: channelActivity(channels),
    },
    notTheSelectedRange: {
      note: 'Do not describe these as the selected range.',
      last30Days: {
        mau: num(summary?.mau),
        d30RetentionPct: engagement?.d30RetentionPct ?? null,
        d30CohortSize: num(engagement?.d30CohortSize),
        d30RetainedCount: num(engagement?.d30RetainedCount),
        creatorCount: num(engagement?.creatorCount),
        creatorMauCount: num(engagement?.creatorMauCount),
        creatorPct: engagement?.creatorPct ?? null,
      },
      lifetime: {
        totalUsers: num(summary?.totalUsers),
        activationPct: engagement?.activationPct ?? null,
        activationCount: num(engagement?.activationCount),
        activationEligibleCount: num(engagement?.activationEligibleCount),
        connectedUserCount: num(engagement?.connectedUserCount),
        connectedUserPct: engagement?.connectedUserPct ?? null,
        groupsThatExist: num(groups?.activeGroups),
      },
      currentSubscribers: monetization
        ? {
            payingPremium: num(monetization.payingPremium),
            payingPremiumPlus: num(monetization.payingPremiumPlus),
            compedPremium: num(monetization.compedPremium),
            compedPremiumPlus: num(monetization.compedPremiumPlus),
          }
        : null,
      referralsAllTime: input.referrals
        ? { totalRecruits: input.referrals.totalRecruits ?? null }
        : null,
    },
  };
}

function periodFor(range: AnalyticsRange, asOfIso: string | null) {
  const parsed = asOfIso ? new Date(asOfIso) : new Date();
  const end = Number.isNaN(parsed.getTime()) ? new Date() : parsed;
  const endDate = end.toISOString().slice(0, 10);
  const days = RANGE_DAYS[range];
  if (days == null) {
    return { range, label: 'all time', startDate: null as string | null, endDate, dayCount: null as number | null };
  }
  const start = new Date(end.getTime() - days * 86_400_000);
  const label =
    range === '7d'
      ? 'the last 7 days'
      : range === '30d'
        ? 'the last 30 days'
        : range === '3m'
          ? 'the last 3 months (90 days)'
          : 'the last year (365 days)';
  return { range, label, startDate: start.toISOString().slice(0, 10), endDate, dayCount: days };
}

function feedGroups(groups: Record<string, unknown> | null) {
  const rows = Array.isArray(groups?.topGroups) ? groups.topGroups : [];
  const groupsWithFeedPosts = rows.flatMap((row) => {
    const record = asRecord(row);
    const posts = num(record?.rootPostsInRange) ?? 0;
    if (!record || posts <= 0) return [];
    return [{
      name: record.name ?? null,
      slug: record.slug ?? null,
      rootPostsInRange: posts,
      replyRate24hPct: record.replyRate24hPct ?? null,
    }];
  });
  return {
    groupRootPostsInRange: num(groups?.groupRootPostsInRange),
    groupRepliesInRange: num(groups?.groupRepliesInRange),
    newMembershipsInRange: num(groups?.newActiveMembershipsInRange),
    groupsWithFeedPosts,
  };
}

function channelActivity(channels: Record<string, unknown> | null) {
  const rows = Array.isArray(channels?.topChannels) ? channels.topChannels : [];
  const byGroup = new Map<string, { groupName: string; groupSlug: string; messagesInRange: number }>();
  const topChannels = rows.flatMap((row) => {
    const record = asRecord(row);
    if (!record) return [];
    const messages = num(record.messagesInRange) ?? 0;
    const slug = String(record.groupSlug ?? '');
    const existing = byGroup.get(slug) ?? {
      groupName: String(record.groupName ?? slug),
      groupSlug: slug,
      messagesInRange: 0,
    };
    existing.messagesInRange += messages;
    byGroup.set(slug, existing);
    return [{
      groupName: record.groupName ?? null,
      groupSlug: record.groupSlug ?? null,
      channelName: record.channelName ?? null,
      messagesInRange: messages,
      sendersInRange: num(record.sendersInRange),
    }];
  });
  return {
    messagesInRange: num(channels?.messagesInRange),
    threadRepliesInRange: num(channels?.threadRepliesInRange),
    sendersInRange: num(channels?.sendersInRange),
    channelsWithActivityInRange: num(channels?.channelsWithActivityInRange),
    marvRepliesInRange: num(channels?.marvRepliesInRange),
    topChannels,
    groupsByChannelMessages: [...byGroup.values()].sort((a, b) => b.messagesInRange - a.messagesInRange),
  };
}

function sumSeries(value: unknown): number | null {
  if (!Array.isArray(value)) return null;
  let total = 0;
  let any = false;
  for (const point of value) {
    const count = num(asRecord(point)?.count);
    if (count == null) continue;
    total += count;
    any = true;
  }
  return any ? total : null;
}

function num(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  return value as Record<string, unknown>;
}
