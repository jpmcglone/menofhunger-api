import { Injectable, Logger, ServiceUnavailableException } from '@nestjs/common';
import type { AnalyticsRange } from '../../common/dto/admin-analytics.dto';
import { MarvinAIService, MarvinAINotConfiguredError } from '../marvin/services/marvin-ai.service';

const MAX_JSON_CHARS = 160_000;
const SERIES_KEEP = 30;

const SERIES_KEYS = [
  'signups',
  'posts',
  'aiPosts',
  'checkins',
  'messages',
  'aiMessages',
  'follows',
] as const;

export type AdminAnalyticsBriefInput = {
  range: AnalyticsRange;
  analytics: Record<string, unknown>;
  referrals?: Record<string, unknown> | null;
};

@Injectable()
export class AdminAnalyticsBriefService {
  private readonly logger = new Logger(AdminAnalyticsBriefService.name);

  constructor(private readonly ai: MarvinAIService) {}

  async brief(adminUserId: string, input: AdminAnalyticsBriefInput): Promise<{ brief: string }> {
    if (!this.ai.isConfigured()) {
      throw new ServiceUnavailableException('Marv is not configured on this server.');
    }

    const snapshot = compactSnapshot(input);
    const json = JSON.stringify(snapshot);
    const developerNote = [
      'The admin is asking how the Men of Hunger platform is doing.',
      `The selected analytics range is ${input.range}.`,
      'The user message is a JSON snapshot of the admin analytics page they already loaded.',
      'Do not use tools. Do not invent numbers that are not in the JSON.',
      'Write a short plain-language briefing: what is healthy, what is weak, and one or two things to watch.',
      'No preamble, no markdown headings. A few short paragraphs or tight bullets.',
    ].join(' ');

    let result;
    try {
      result = await this.ai.respond({
        source: 'catch_up',
        mode: 'regular',
        developerNote,
        userMessage: json,
        dispatchTool: async () => 'Tools are disabled for this admin briefing. Use only the JSON.',
        toolContext: { requesterUserId: adminUserId },
        cacheKey: `admin:analytics-brief:${input.range}`,
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

function compactSnapshot(input: AdminAnalyticsBriefInput): Record<string, unknown> {
  const analytics = { ...input.analytics };
  for (const key of SERIES_KEYS) {
    const series = analytics[key];
    if (Array.isArray(series) && series.length > SERIES_KEEP) {
      analytics[key] = series.slice(-SERIES_KEEP);
    }
  }
  const coins = asRecord(analytics.coins);
  if (coins && Array.isArray(coins.minted) && coins.minted.length > SERIES_KEEP) {
    analytics.coins = { ...coins, minted: coins.minted.slice(-SERIES_KEEP) };
  }
  const articles = asRecord(analytics.articles);
  if (articles) {
    const next = { ...articles };
    if (Array.isArray(next.published) && next.published.length > SERIES_KEEP) {
      next.published = next.published.slice(-SERIES_KEEP);
    }
    if (Array.isArray(next.views) && next.views.length > SERIES_KEEP) {
      next.views = next.views.slice(-SERIES_KEEP);
    }
    analytics.articles = next;
  }
  const ai = asRecord(analytics.ai);
  if (ai && Array.isArray(ai.interactions) && ai.interactions.length > SERIES_KEEP) {
    analytics.ai = { ...ai, interactions: ai.interactions.slice(-SERIES_KEEP) };
  }

  const referrals = input.referrals ? { ...input.referrals } : null;
  if (referrals && Array.isArray(referrals.recruitsOverTime) && referrals.recruitsOverTime.length > SERIES_KEEP) {
    referrals.recruitsOverTime = referrals.recruitsOverTime.slice(-SERIES_KEEP);
  }

  const snapshot: Record<string, unknown> = { range: input.range, analytics, referrals };
  const json = JSON.stringify(snapshot);
  if (json.length <= MAX_JSON_CHARS) return snapshot;

  // Last-resort trim: drop remaining series so the model still gets KPIs.
  for (const key of SERIES_KEYS) delete analytics[key];
  if (coins) analytics.coins = { ...coins, minted: [] };
  if (articles) analytics.articles = { ...articles, published: [], views: [] };
  if (ai) analytics.ai = { ...ai, interactions: [] };
  if (referrals) referrals.recruitsOverTime = [];
  return { range: input.range, analytics, referrals };
}

function asRecord(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  return value as Record<string, unknown>;
}
