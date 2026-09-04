import { Injectable, Logger, ServiceUnavailableException } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { AppConfigService } from '../app/app-config.service';
import { AiUtilityService } from '../ai/ai-utility.service';
import type { AdminIntroBriefDto, AdminIntroPairDto, AdminIntroPersonDto } from '../../common/dto/admin-intro-brief.dto';
import { canonicalizeTopicValue } from '../../common/topics/topic-utils';

type CandidateRow = {
  leftUserId: string;
  leftUsername: string;
  leftName: string | null;
  rightUserId: string;
  rightUsername: string;
  rightName: string | null;
  topics: string[];
  overlap: number;
};

const CANDIDATE_LIMIT = 40;
const PAIR_LIMIT = 5;

const INSTRUCTIONS = [
  'You are briefing the Men of Hunger admin on who to introduce this week.',
  'The user message is a JSON list of candidate pairs. They already share public post topics and do not follow each other.',
  'Pick up to 5 pairs that would actually benefit from a human intro. Skip weak or creepy matches.',
  'Do not invent usernames, topics, or numbers. Do not write DMs. Do not mention ethnicity, race, or politics-as-identity.',
  'Return ONLY JSON: { "brief": string, "pairs": [{ "leftUsername", "rightUsername", "topics": string[], "reason": string }] }',
  'brief: 2–4 short paragraphs for the admin. reason: one sentence.',
].join(' ');

@Injectable()
export class AdminIntroBriefService {
  private readonly logger = new Logger(AdminIntroBriefService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly ai: AiUtilityService,
    private readonly appConfig: AppConfigService,
  ) {}

  async latest(): Promise<AdminIntroBriefDto | null> {
    const row = await this.prisma.adminIntroBrief.findFirst({
      orderBy: { createdAt: 'desc' },
    });
    return row ? toDto(row) : null;
  }

  async generate(): Promise<AdminIntroBriefDto> {
    if (!this.ai.isConfigured()) {
      throw new ServiceUnavailableException('OpenAI is not configured on this server.');
    }

    const weekKey = isoWeekKeyEt(new Date());
    const candidates = await this.loadCandidates();
    if (candidates.length === 0) {
      const saved = await this.prisma.adminIntroBrief.upsert({
        where: { weekKey },
        create: {
          weekKey,
          brief:
            'Not enough public topic overlap yet. Once more posts are labeled, this briefing will suggest men to introduce.',
          pairsJson: [],
          modelUsed: 'none',
        },
        update: {
          brief:
            'Not enough public topic overlap yet. Once more posts are labeled, this briefing will suggest men to introduce.',
          pairsJson: [],
          modelUsed: 'none',
        },
      });
      return toDto(saved);
    }

    const model = this.appConfig.marvOpenAI().astraModel;
    const result = await this.ai.complete({
      model,
      instructions: INSTRUCTIONS,
      userMessage: JSON.stringify(
        candidates.map((c) => ({
          leftUsername: c.leftUsername,
          rightUsername: c.rightUsername,
          topics: c.topics,
          sharedTopicCount: c.overlap,
        })),
      ),
      maxOutputTokens: 2_048,
      reasoningEffort: 'high',
      cacheKey: `admin:intro-brief:${weekKey}`,
    });
    if (!result?.text) {
      this.logger.warn('[admin-intro-brief] Astra returned no text');
      throw new ServiceUnavailableException('Could not write this week’s intros. Try again.');
    }

    const parsed = parseBriefJson(result.text);
    const people = new Map<string, AdminIntroPersonDto>();
    for (const c of candidates) {
      people.set(c.leftUsername.toLowerCase(), {
        id: c.leftUserId,
        username: c.leftUsername,
        name: c.leftName,
      });
      people.set(c.rightUsername.toLowerCase(), {
        id: c.rightUserId,
        username: c.rightUsername,
        name: c.rightName,
      });
    }

    const pairs: AdminIntroPairDto[] = [];
    for (const raw of parsed.pairs) {
      const left = people.get(raw.leftUsername.toLowerCase());
      const right = people.get(raw.rightUsername.toLowerCase());
      if (!left || !right || left.id === right.id) continue;
      const topics = raw.topics.map((t) => canonicalizeTopicValue(t)).filter((t): t is string => Boolean(t));
      if (topics.length === 0) continue;
      pairs.push({
        left,
        right,
        topics,
        reason: raw.reason.slice(0, 280),
      });
      if (pairs.length >= PAIR_LIMIT) break;
    }

    const brief = parsed.brief.trim() || 'Here are the strongest public overlaps this week.';
    const saved = await this.prisma.adminIntroBrief.upsert({
      where: { weekKey },
      create: {
        weekKey,
        brief,
        pairsJson: pairs as unknown as Prisma.InputJsonValue,
        modelUsed: result.modelUsed,
      },
      update: {
        brief,
        pairsJson: pairs as unknown as Prisma.InputJsonValue,
        modelUsed: result.modelUsed,
      },
    });
    return toDto(saved);
  }

  private async loadCandidates(): Promise<CandidateRow[]> {
    return this.prisma.$queryRaw<CandidateRow[]>(Prisma.sql`
      WITH user_topics AS (
        SELECT
          p."userId",
          u."username",
          u."name",
          ARRAY_AGG(DISTINCT t) AS topics,
          COUNT(*)::int AS post_count
        FROM "Post" p
        JOIN "User" u ON u."id" = p."userId"
        CROSS JOIN LATERAL UNNEST(p."topics") AS t
        WHERE p."deletedAt" IS NULL
          AND p."visibility" = 'public'
          AND p."communityGroupId" IS NULL
          AND p."createdAt" > NOW() - INTERVAL '30 days'
          AND cardinality(p."topics") > 0
          AND u."isBot" = false
          AND u."bannedAt" IS NULL
          AND u."usernameIsSet" = true
          AND u."username" IS NOT NULL
        GROUP BY p."userId", u."username", u."name"
        HAVING COUNT(*) >= 2
      )
      SELECT
        a."userId" AS "leftUserId",
        a."username" AS "leftUsername",
        a."name" AS "leftName",
        b."userId" AS "rightUserId",
        b."username" AS "rightUsername",
        b."name" AS "rightName",
        ARRAY(SELECT unnest(a.topics) INTERSECT SELECT unnest(b.topics)) AS topics,
        COALESCE(
          array_length(ARRAY(SELECT unnest(a.topics) INTERSECT SELECT unnest(b.topics)), 1),
          0
        )::int AS overlap
      FROM user_topics a
      JOIN user_topics b ON a."userId" < b."userId"
      WHERE COALESCE(
          array_length(ARRAY(SELECT unnest(a.topics) INTERSECT SELECT unnest(b.topics)), 1),
          0
        ) >= 2
        AND NOT EXISTS (
          SELECT 1
          FROM "Follow" f
          WHERE (f."followerId" = a."userId" AND f."followingId" = b."userId")
             OR (f."followerId" = b."userId" AND f."followingId" = a."userId")
        )
      ORDER BY overlap DESC, (a.post_count + b.post_count) DESC
      LIMIT ${CANDIDATE_LIMIT}
    `);
  }
}

function toDto(row: {
  weekKey: string;
  brief: string;
  pairsJson: unknown;
  modelUsed: string;
  createdAt: Date;
}): AdminIntroBriefDto {
  return {
    weekKey: row.weekKey,
    brief: row.brief,
    pairs: Array.isArray(row.pairsJson) ? (row.pairsJson as AdminIntroPairDto[]) : [],
    modelUsed: row.modelUsed,
    createdAt: row.createdAt.toISOString(),
  };
}

function parseBriefJson(raw: string): {
  brief: string;
  pairs: Array<{ leftUsername: string; rightUsername: string; topics: string[]; reason: string }>;
} {
  const text = raw.trim();
  const start = text.indexOf('{');
  const end = text.lastIndexOf('}');
  const slice = start >= 0 && end > start ? text.slice(start, end + 1) : text;
  let parsed: any;
  try {
    parsed = JSON.parse(slice);
  } catch {
    return { brief: '', pairs: [] };
  }
  const brief = typeof parsed?.brief === 'string' ? parsed.brief : '';
  const pairsIn = Array.isArray(parsed?.pairs) ? parsed.pairs : [];
  const pairs = [];
  for (const item of pairsIn) {
    const leftUsername = String(item?.leftUsername ?? '').trim();
    const rightUsername = String(item?.rightUsername ?? '').trim();
    const reason = String(item?.reason ?? '').trim();
    const topics = Array.isArray(item?.topics) ? item.topics.map((t: unknown) => String(t ?? '')) : [];
    if (!leftUsername || !rightUsername || !reason) continue;
    pairs.push({ leftUsername, rightUsername, topics, reason });
  }
  return { brief, pairs };
}

function isoWeekKeyEt(now: Date): string {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'America/New_York',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(now);
  const y = Number(parts.find((p) => p.type === 'year')?.value ?? 0);
  const m = Number(parts.find((p) => p.type === 'month')?.value ?? 1);
  const d = Number(parts.find((p) => p.type === 'day')?.value ?? 1);
  const date = new Date(Date.UTC(y, m - 1, d));
  const day = date.getUTCDay() || 7;
  date.setUTCDate(date.getUTCDate() + 4 - day);
  const yearStart = new Date(Date.UTC(date.getUTCFullYear(), 0, 1));
  const week = Math.ceil(((date.getTime() - yearStart.getTime()) / 86400000 + 1) / 7);
  return `${date.getUTCFullYear()}-W${String(week).padStart(2, '0')}`;
}
