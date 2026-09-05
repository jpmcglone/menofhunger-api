import { Injectable, Logger, ServiceUnavailableException } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { AppConfigService } from '../app/app-config.service';
import { AiUtilityService } from '../ai/ai-utility.service';
import { JobsService } from '../jobs/jobs.service';
import { JOBS } from '../jobs/jobs.constants';
import type { AdminIntroBriefDto, AdminIntroBriefQueuedDto, AdminIntroPairDto, AdminIntroPersonDto } from '../../common/dto/admin-intro-brief.dto';
import { canonicalizeTopicValue } from '../../common/topics/topic-utils';
import {
  AFFINITY_SEARCH_DAYS,
  INTRO_POST_DAYS,
  mergedUserTopicsSql,
  userTopicSourceCtesSql,
} from '../../common/discovery/user-affinity.sql';

type CandidateRow = {
  leftUserId: string;
  leftUsername: string;
  leftName: string | null;
  rightUserId: string;
  rightUsername: string;
  rightName: string | null;
  topics: string[];
  groups: string[];
  overlap: number;
  groupOverlap: number;
};

const CANDIDATE_LIMIT = 40;
const PAIR_LIMIT = 5;

const INSTRUCTIONS = [
  'You are briefing the Men of Hunger admin on who to introduce this week.',
  'The user message is a JSON list of candidate pairs. They share public post topics, group memberships, and/or search interests, and do not follow each other.',
  'Pick up to 5 pairs that would actually benefit from a human intro. Prefer a shared group plus shared topics. Skip weak or creepy matches.',
  'Do not invent usernames, topics, groups, or numbers. Do not write DMs. Do not mention searches, ethnicity, race, or politics-as-identity.',
  'Return ONLY JSON: { "brief": string, "pairs": [{ "leftUsername", "rightUsername", "topics": string[], "groups": string[], "reason": string }] }',
  'topics and groups must come from that pair’s candidate list. brief: 2–4 short paragraphs for the admin. reason: one sentence.',
].join(' ');

@Injectable()
export class AdminIntroBriefService {
  private readonly logger = new Logger(AdminIntroBriefService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly ai: AiUtilityService,
    private readonly appConfig: AppConfigService,
    private readonly jobs: JobsService,
  ) {}

  currentWeekKey(now = new Date()): string {
    return isoWeekKeyEt(now);
  }

  async enqueueGenerate(): Promise<AdminIntroBriefQueuedDto> {
    const weekKey = this.currentWeekKey();
    try {
      await this.jobs.enqueue(
        JOBS.adminIntroBrief,
        {},
        {
          jobId: `admin-intro-brief-${weekKey}`,
          attempts: 2,
          backoff: { type: 'exponential', delay: 30_000 },
        },
      );
    } catch {
      // Already queued or active for this week.
    }
    return { queued: true, weekKey };
  }

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
      const writtenAt = new Date();
      const saved = await this.prisma.adminIntroBrief.upsert({
        where: { weekKey },
        create: {
          weekKey,
          brief:
            'Not enough overlap yet. Once more men share topics or groups, this briefing will suggest who to introduce.',
          pairsJson: [],
          modelUsed: 'none',
          createdAt: writtenAt,
        },
        update: {
          brief:
            'Not enough overlap yet. Once more men share topics or groups, this briefing will suggest who to introduce.',
          pairsJson: [],
          modelUsed: 'none',
          createdAt: writtenAt,
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
          groups: c.groups,
          sharedTopicCount: c.overlap,
          sharedGroupCount: c.groupOverlap,
        })),
      ),
      maxOutputTokens: 2_048,
      reasoningEffort: 'medium',
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
      const candidate = findCandidate(candidates, raw.leftUsername, raw.rightUsername);
      const topics = uniqueStrings([
        ...raw.topics.map((t) => canonicalizeTopicValue(t)).filter((t): t is string => Boolean(t)),
        ...(candidate?.topics ?? []),
      ]);
      const allowedGroups = new Set((candidate?.groups ?? []).map((name) => name.toLowerCase()));
      const groups = uniqueStrings([
        ...raw.groups.filter((name) => allowedGroups.has(name.toLowerCase())),
        ...(candidate?.groups ?? []),
      ]);
      if (topics.length === 0 && groups.length === 0) continue;
      pairs.push({
        left,
        right,
        topics,
        groups,
        reason: raw.reason.slice(0, 280),
      });
      if (pairs.length >= PAIR_LIMIT) break;
    }

    const brief = parsed.brief.trim() || 'Here are the strongest public overlaps this week.';
    const writtenAt = new Date();
    const saved = await this.prisma.adminIntroBrief.upsert({
      where: { weekKey },
      create: {
        weekKey,
        brief,
        pairsJson: pairs as unknown as Prisma.InputJsonValue,
        modelUsed: result.modelUsed,
        createdAt: writtenAt,
      },
      update: {
        brief,
        pairsJson: pairs as unknown as Prisma.InputJsonValue,
        modelUsed: result.modelUsed,
        createdAt: writtenAt,
      },
    });
    return toDto(saved);
  }

  private async loadCandidates(): Promise<CandidateRow[]> {
    return this.prisma.$queryRaw<CandidateRow[]>(Prisma.sql`
      WITH
      ${userTopicSourceCtesSql({ postDays: INTRO_POST_DAYS, searchDays: AFFINITY_SEARCH_DAYS })},
      user_affinity AS (
        SELECT
          u."id" AS "userId",
          u."username",
          u."name",
          ${mergedUserTopicsSql()} AS topics,
          ARRAY(
            SELECT cgm."groupId"
            FROM "CommunityGroupMember" cgm
            JOIN "CommunityGroup" g ON g."id" = cgm."groupId" AND g."deletedAt" IS NULL
            WHERE cgm."userId" = u."id"
              AND cgm."status" = 'active'
          ) AS group_ids,
          COALESCE((
            SELECT COUNT(*)::int
            FROM "Post" p
            WHERE p."userId" = u."id"
              AND p."deletedAt" IS NULL
              AND p."visibility" = 'public'
              AND p."createdAt" > NOW() - (${INTRO_POST_DAYS}::int * INTERVAL '1 day')
          ), 0) AS post_count
        FROM "User" u
        LEFT JOIN post_topics pt ON pt."userId" = u."id"
        LEFT JOIN search_topics st ON st."userId" = u."id"
        LEFT JOIN group_name_topics gt ON gt."userId" = u."id"
        WHERE u."isBot" = false
          AND u."bannedAt" IS NULL
          AND u."usernameIsSet" = true
          AND u."username" IS NOT NULL
          AND (
            COALESCE((
              SELECT COUNT(*)::int
              FROM "Post" p
              WHERE p."userId" = u."id"
                AND p."deletedAt" IS NULL
                AND p."visibility" = 'public'
                AND p."createdAt" > NOW() - (${INTRO_POST_DAYS}::int * INTERVAL '1 day')
            ), 0) >= 1
            OR EXISTS (
              SELECT 1
              FROM "CommunityGroupMember" cgm
              JOIN "CommunityGroup" g ON g."id" = cgm."groupId" AND g."deletedAt" IS NULL
              WHERE cgm."userId" = u."id"
                AND cgm."status" = 'active'
            )
          )
      )
      SELECT
        a."userId" AS "leftUserId",
        a."username" AS "leftUsername",
        a."name" AS "leftName",
        b."userId" AS "rightUserId",
        b."username" AS "rightUsername",
        b."name" AS "rightName",
        ARRAY(SELECT unnest(a.topics) INTERSECT SELECT unnest(b.topics)) AS topics,
        ARRAY(
          SELECT g."name"
          FROM "CommunityGroup" g
          WHERE g."id" IN (
            SELECT unnest(a.group_ids) INTERSECT SELECT unnest(b.group_ids)
          )
          ORDER BY g."name"
        ) AS groups,
        COALESCE(
          array_length(ARRAY(SELECT unnest(a.topics) INTERSECT SELECT unnest(b.topics)), 1),
          0
        )::int AS overlap,
        COALESCE(
          array_length(ARRAY(SELECT unnest(a.group_ids) INTERSECT SELECT unnest(b.group_ids)), 1),
          0
        )::int AS "groupOverlap"
      FROM user_affinity a
      JOIN user_affinity b ON a."userId" < b."userId"
      WHERE (
          COALESCE(
            array_length(ARRAY(SELECT unnest(a.topics) INTERSECT SELECT unnest(b.topics)), 1),
            0
          ) >= 2
          OR (
            COALESCE(
              array_length(ARRAY(SELECT unnest(a.group_ids) INTERSECT SELECT unnest(b.group_ids)), 1),
              0
            ) >= 1
            AND COALESCE(
              array_length(ARRAY(SELECT unnest(a.topics) INTERSECT SELECT unnest(b.topics)), 1),
              0
            ) >= 1
          )
          OR COALESCE(
            array_length(ARRAY(SELECT unnest(a.group_ids) INTERSECT SELECT unnest(b.group_ids)), 1),
            0
          ) >= 2
        )
        AND NOT EXISTS (
          SELECT 1
          FROM "Follow" f
          WHERE (f."followerId" = a."userId" AND f."followingId" = b."userId")
             OR (f."followerId" = b."userId" AND f."followingId" = a."userId")
        )
      ORDER BY
        (
          COALESCE(array_length(ARRAY(SELECT unnest(a.topics) INTERSECT SELECT unnest(b.topics)), 1), 0) * 3
          + COALESCE(array_length(ARRAY(SELECT unnest(a.group_ids) INTERSECT SELECT unnest(b.group_ids)), 1), 0) * 4
        ) DESC,
        (a.post_count + b.post_count) DESC
      LIMIT ${CANDIDATE_LIMIT}
    `);
  }
}

function uniqueStrings(values: string[]): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const raw of values) {
    const value = raw.trim();
    if (!value) continue;
    const key = value.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(value);
  }
  return out;
}

function findCandidate(
  candidates: CandidateRow[],
  leftUsername: string,
  rightUsername: string,
): CandidateRow | undefined {
  const left = leftUsername.toLowerCase();
  const right = rightUsername.toLowerCase();
  return candidates.find((row) => {
    const a = row.leftUsername.toLowerCase();
    const b = row.rightUsername.toLowerCase();
    return (a === left && b === right) || (a === right && b === left);
  });
}

function normalizeStoredPairs(raw: unknown): AdminIntroPairDto[] {
  if (!Array.isArray(raw)) return [];
  const out: AdminIntroPairDto[] = [];
  for (const item of raw) {
    const pair = item as AdminIntroPairDto;
    if (!pair?.left || !pair?.right) continue;
    out.push({
      left: pair.left,
      right: pair.right,
      topics: Array.isArray(pair.topics) ? pair.topics : [],
      groups: Array.isArray(pair.groups) ? pair.groups : [],
      reason: typeof pair.reason === 'string' ? pair.reason : '',
    });
  }
  return out;
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
    pairs: normalizeStoredPairs(row.pairsJson),
    modelUsed: row.modelUsed,
    createdAt: row.createdAt.toISOString(),
  };
}

function parseBriefJson(raw: string): {
  brief: string;
  pairs: Array<{ leftUsername: string; rightUsername: string; topics: string[]; groups: string[]; reason: string }>;
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
    const groups = Array.isArray(item?.groups) ? item.groups.map((g: unknown) => String(g ?? '').trim()).filter(Boolean) : [];
    if (!leftUsername || !rightUsername || !reason) continue;
    pairs.push({ leftUsername, rightUsername, topics, groups, reason });
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
