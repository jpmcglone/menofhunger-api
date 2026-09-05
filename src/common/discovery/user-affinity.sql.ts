import { Prisma } from '@prisma/client';
import { TOPIC_OPTIONS } from '../topics/topic-options';

/** Public posts (home or group) that still count toward match topics. */
export const AFFINITY_POST_DAYS = 180;
export const INTRO_POST_DAYS = 90;
/** Typed searches and profile/group taps. Matches UserSearch retention. */
export const AFFINITY_SEARCH_DAYS = 90;

function normalizePhrase(value: string): string {
  return String(value ?? '')
    .trim()
    .toLowerCase()
    .replace(/_/g, ' ')
    .replace(/[^a-z0-9 ]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function topicPhrasePairs(): Array<{ value: string; phrase: string }> {
  const out: Array<{ value: string; phrase: string }> = [];
  const seen = new Set<string>();
  for (const option of TOPIC_OPTIONS) {
    const phrases = [option.value, option.label, ...(option.aliases ?? [])]
      .map(normalizePhrase)
      .filter((phrase) => phrase.length >= 2);
    for (const phrase of phrases) {
      const key = `${option.value}\0${phrase}`;
      if (seen.has(key)) continue;
      seen.add(key);
      out.push({ value: option.value, phrase });
    }
  }
  return out;
}

export function topicPhrasePairCount(): number {
  return topicPhrasePairs().length;
}

export function topicPhrasesCteSql(): Prisma.Sql {
  const rows = topicPhrasePairs().map(
    (row) => Prisma.sql`(${row.value}, ${row.phrase})`,
  );
  return Prisma.sql`topic_phrases AS (
    SELECT * FROM (VALUES ${Prisma.join(rows, ', ')}) AS t(value, phrase)
  )`;
}

/** Whole-word / whole-phrase match after stripping punctuation. */
export function paddedMatchesPhraseSql(textExpr: Prisma.Sql, phraseExpr: Prisma.Sql): Prisma.Sql {
  return Prisma.sql`(
    ' ' || regexp_replace(lower(${textExpr}), '[^a-z0-9]+', ' ', 'g') || ' '
  ) LIKE ('% ' || ${phraseExpr} || ' %')`;
}

/**
 * Shared topic sources: public post topics, typed-search → allowlist, group-name → allowlist.
 * Caller still unions User.interests at the user grain.
 */
export function userTopicSourceCtesSql(params: { postDays: number; searchDays: number }): Prisma.Sql {
  const postDays = Math.max(1, Math.floor(params.postDays));
  const searchDays = Math.max(1, Math.floor(params.searchDays));
  return Prisma.sql`
    ${topicPhrasesCteSql()},
    post_topics AS (
      SELECT p."userId", ARRAY_AGG(DISTINCT t) AS topics
      FROM "Post" p
      CROSS JOIN LATERAL UNNEST(p."topics") AS t
      WHERE p."deletedAt" IS NULL
        AND p."visibility" = 'public'
        AND p."createdAt" > NOW() - (${postDays}::int * INTERVAL '1 day')
        AND cardinality(p."topics") > 0
      GROUP BY p."userId"
    ),
    search_topics AS (
      SELECT q."userId", ARRAY_AGG(DISTINCT tp.value) AS topics
      FROM (
        SELECT DISTINCT us."userId", lower(btrim(us."query")) AS query
        FROM "UserSearch" us
        WHERE us."createdAt" > NOW() - (${searchDays}::int * INTERVAL '1 day')
          AND us."targetUserId" IS NULL
          AND us."targetGroupId" IS NULL
          AND btrim(us."query") <> ''
      ) q
      JOIN topic_phrases tp ON ${paddedMatchesPhraseSql(Prisma.sql`q.query`, Prisma.sql`tp.phrase`)}
      GROUP BY q."userId"
    ),
    group_name_topics AS (
      SELECT cgm."userId", ARRAY_AGG(DISTINCT tp.value) AS topics
      FROM "CommunityGroupMember" cgm
      JOIN "CommunityGroup" g ON g."id" = cgm."groupId" AND g."deletedAt" IS NULL
      JOIN topic_phrases tp ON ${paddedMatchesPhraseSql(Prisma.sql`g."name"`, Prisma.sql`tp.phrase`)}
      WHERE cgm."status" = 'active'
      GROUP BY cgm."userId"
    )
  `;
}

export function viewerPostTopicsSql(viewerUserId: string, postDays: number): Prisma.Sql {
  const days = Math.max(1, Math.floor(postDays));
  return Prisma.sql`ARRAY(
    SELECT DISTINCT t
    FROM "Post" p
    CROSS JOIN LATERAL UNNEST(p."topics") AS t
    WHERE p."userId" = ${viewerUserId}
      AND p."deletedAt" IS NULL
      AND p."visibility" = 'public'
      AND p."createdAt" > NOW() - (${days}::int * INTERVAL '1 day')
      AND cardinality(p."topics") > 0
  )`;
}

export function viewerSearchTopicsSql(viewerUserId: string, searchDays: number): Prisma.Sql {
  const days = Math.max(1, Math.floor(searchDays));
  return Prisma.sql`ARRAY(
    SELECT DISTINCT tp.value
    FROM "UserSearch" us
    JOIN topic_phrases tp ON ${paddedMatchesPhraseSql(Prisma.sql`us."query"`, Prisma.sql`tp.phrase`)}
    WHERE us."userId" = ${viewerUserId}
      AND us."createdAt" > NOW() - (${days}::int * INTERVAL '1 day')
      AND us."targetUserId" IS NULL
      AND us."targetGroupId" IS NULL
  )`;
}

export function viewerGroupNameTopicsSql(viewerUserId: string): Prisma.Sql {
  return Prisma.sql`ARRAY(
    SELECT DISTINCT tp.value
    FROM "CommunityGroupMember" cgm
    JOIN "CommunityGroup" g ON g."id" = cgm."groupId" AND g."deletedAt" IS NULL
    JOIN topic_phrases tp ON ${paddedMatchesPhraseSql(Prisma.sql`g."name"`, Prisma.sql`tp.phrase`)}
    WHERE cgm."userId" = ${viewerUserId}
      AND cgm."status" = 'active'
  )`;
}

export function mergedPoolUserTopicsSql(): Prisma.Sql {
  return Prisma.sql`ARRAY(
    SELECT DISTINCT s.t
    FROM (
      SELECT unnest(u."interests") AS t
      UNION
      SELECT unnest(COALESCE(ppt."topics", ARRAY[]::text[]))
      UNION
      SELECT unnest(COALESCE(pgt."topics", ARRAY[]::text[]))
    ) s
    WHERE s.t IS NOT NULL AND btrim(s.t) <> ''
  )`;
}

export function mergedUserTopicsSql(): Prisma.Sql {
  return Prisma.sql`ARRAY(
    SELECT DISTINCT s.t
    FROM (
      SELECT unnest(u."interests") AS t
      UNION
      SELECT unnest(COALESCE(pt."topics", ARRAY[]::text[]))
      UNION
      SELECT unnest(COALESCE(st."topics", ARRAY[]::text[]))
      UNION
      SELECT unnest(COALESCE(gt."topics", ARRAY[]::text[]))
    ) s
    WHERE s.t IS NOT NULL AND btrim(s.t) <> ''
  )`;
}
