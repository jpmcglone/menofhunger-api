import { Prisma } from '@prisma/client';
import { POST_BASE_INCLUDE } from '../../common/prisma-includes/post.include';
import { createdAtIdCursorWhere } from '../../common/pagination/created-at-id-cursor';
import { queryToTopicValues } from '../../common/topics/topic-utils';
import { buildPostVisibilityWhere } from '../../common/posts/post-visibility';
import type { SearchService } from './search.service';
import {
  POST_SCORE,
  SEARCH_POST_INCLUDE,
  SEMANTIC_MAX_DISTANCE,
  SEMANTIC_RESCUE_BELOW,
  TOPIC_RESCUE_BELOW,
  extractQuotedPhrases,
  queryToWords,
  splitSearchQuery,
  type SearchPostRow,
} from './search.shared';

export async function searchPostsOn(host: SearchService, params: { viewerUserId: string | null; q: string; limit: number; cursor: string | null; kind?: 'regular' | 'checkin' | null }) {
  const rawQ = (params.q ?? '').trim();
  if (!rawQ) return { posts: [], nextCursor: null };
  const limit = Math.max(1, Math.min(50, params.limit || 30));
  const cursor = params.cursor ?? null;
  const kind = params.kind ?? null;
  const { hashtags, cashtags: cashtagCandidates, text: qText } = splitSearchQuery(rawQ);
  const tagsText = hashtags.join(' ').trim();
  const qFtsExpanded = (qText ? `${qText} ${tagsText}` : tagsText).trim(); // preserve quotes for websearch_to_tsquery
  const qMatchBase = qText.replace(/"/g, ' ').replace(/\s+/g, ' ').trim();
  const qMatchExpanded = (qMatchBase ? `${qMatchBase} ${tagsText}` : tagsText).trim();
  if (!qMatchExpanded && hashtags.length === 0 && cashtagCandidates.length === 0) return { posts: [], nextCursor: null };
  const phrases = extractQuotedPhrases(qText);
  const phraseLowers = phrases.map((p) => p.toLowerCase());
  const words = queryToWords(qMatchExpanded);
  const qLower = qMatchExpanded.toLowerCase();
  let topicValues = queryToTopicValues(qMatchExpanded);

  const viewer = (await host.viewerContext.getViewer(params.viewerUserId ?? null)) as any;
  const allowed = host.allowedVisibilitiesForViewer(viewer);
  const readableGroupPostWhere = host.readableGroupPostWhere(viewer);

  // Never include onlyMe posts in search results (even for the viewer).
  const visibilityWhere = buildPostVisibilityWhere({ viewerUserId: viewer?.id ?? null, allowed });
  // Always exclude flat reposts from search; their content is redundant with the original post.
  const kindWhere: Prisma.PostWhereInput = kind ? ({ kind } as Prisma.PostWhereInput) : { kind: { not: 'repost' } };

  const cursorRaw = (cursor ?? '').trim();
  const cursorIsOffset = cursorRaw ? /^\d+$/.test(cursorRaw) : false;
  const offset = cursorIsOffset ? Math.max(0, parseInt(cursorRaw, 10)) : 0;
  const cursorIsTextPhase = cursorRaw.startsWith('t:');
  const cursorPostId =
    cursorRaw && !cursorIsOffset
      ? ((cursorIsTextPhase ? cursorRaw.slice(2) : (cursorRaw.startsWith('p:') ? cursorRaw.slice(2) : cursorRaw)).trim() || null)
      : null;

  const hashtagWhere: Prisma.PostWhereInput =
    hashtags.length > 0 ? ({ hashtags: { hasSome: hashtags } } as Prisma.PostWhereInput) : {};

  // Fast path: cashtag-only search (e.g. "$SPY").
  // Match both the cashtags[] array column AND the literal $SYMBOL in body so
  // posts created before the ticker set was warm (empty cashtags[]) still surface.
  const isCashtagOnly = cashtagCandidates.length > 0 && hashtags.length === 0 && !qMatchBase;
  if (isCashtagOnly) {
    const cashtagBodyOr: Prisma.PostWhereInput = {
      OR: [
        { cashtags: { hasSome: cashtagCandidates } } as Prisma.PostWhereInput,
        ...cashtagCandidates.map((sym) => ({
          body: { contains: `$${sym}`, mode: 'insensitive' as const },
        })),
      ],
    };

    const cursorWhere = await createdAtIdCursorWhere({
      cursor: (cursor ?? '').trim() || null,
      lookup: async (id) =>
        await host.postsRead.read.findUnique({ where: { id }, select: { id: true, createdAt: true } }),
    });

    const rows = await host.postsRead.read.findMany({
      where: {
        AND: [
          { deletedAt: null },
          readableGroupPostWhere,
          visibilityWhere,
          kindWhere,
          cashtagBodyOr,
          ...(cursorWhere ? [cursorWhere] : []),
        ],
      },
      include: SEARCH_POST_INCLUDE,
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      take: limit + 1,
    });

    const slice = rows.slice(0, limit);
    const next = slice[slice.length - 1]?.id ?? null;
    const nextCursor = rows.length > limit && next ? `p:${next}` : null;
    return { posts: slice, nextCursor };
  }

  // Fast path: hashtag-only search should be cheap and index-backed.
  const isHashtagOnly = hashtags.length > 0 && !qMatchBase;
  if (isHashtagOnly) {
    // Support legacy offset cursor (numeric) but prefer createdAt/id cursor for scalability.
    if (cursorIsOffset) {
      const rows = await host.postsRead.read.findMany({
        where: {
          AND: [{ deletedAt: null }, readableGroupPostWhere, visibilityWhere, kindWhere, hashtagWhere],
        },
        include: {
          user: POST_BASE_INCLUDE.user,
          media: { orderBy: { position: 'asc' } },
          mentions: {
            include: {
              user: {
                select: POST_BASE_INCLUDE.mentions.include.user.select,
              },
            },
          },
        },
        orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
        skip: offset,
        take: limit + 1,
      });
      const slice = rows.slice(0, limit);
      const next = slice[slice.length - 1]?.id ?? null;
      const nextCursor = rows.length > limit && next ? `p:${next}` : null;
      return { posts: slice, nextCursor };
    }

    // Phase 1: hashtag matches (cursor = `p:<postId>`). Phase 2: text matches (`t:<postId>`) excluding hashtag matches.
    if (!cursorIsTextPhase) {
      const cursorWhere = await createdAtIdCursorWhere({
        cursor: cursorPostId,
        lookup: async (id) =>
          await host.postsRead.read.findUnique({
            where: { id },
            select: { id: true, createdAt: true },
          }),
      });

      const rows = await host.postsRead.read.findMany({
        where: {
          AND: [
            { deletedAt: null },
            readableGroupPostWhere,
            visibilityWhere,
            kindWhere,
            hashtagWhere,
            ...(cursorWhere ? [cursorWhere] : []),
          ],
        },
        include: SEARCH_POST_INCLUDE,
        orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
        take: limit + 1,
      });

      // If we still have more hashtag matches, don't show text matches yet (hashtag posts should dominate).
      if (rows.length > limit) {
        const slice = rows.slice(0, limit);
        const next = slice[slice.length - 1]?.id ?? null;
        const nextCursor = next ? `p:${next}` : null;
        return { posts: slice, nextCursor };
      }

      // Hashtag matches are exhausted (or fewer than a page): fill with text matches for the tag words.
      const hashtagSlice = rows.slice(0, limit);
      const remaining = Math.max(0, limit - hashtagSlice.length);
      if (remaining === 0) {
        const probe = await host.fetchHashtagFallbackTextPosts({
          viewer,
          allowed,
          visibilityWhere,
          hashtags,
          queryFts: tagsText,
          queryMatch: tagsText,
          limit: 1,
          cursorPostId: null,
        });
        return { posts: hashtagSlice, nextCursor: probe.posts.length > 0 ? 't:' : null };
      }

      const textRes = await host.fetchHashtagFallbackTextPosts({
        viewer,
        allowed,
        visibilityWhere,
        hashtags,
        queryFts: tagsText,
        queryMatch: tagsText,
        limit: remaining,
        cursorPostId: null,
      });

      const combined = [...hashtagSlice, ...textRes.posts];
      const nextCursor = textRes.nextCursor ? `t:${textRes.nextCursor}` : null;
      return { posts: combined, nextCursor };
    }

    // Phase 2: text-only fallback.
    const textRes = await host.fetchHashtagFallbackTextPosts({
      viewer,
      allowed,
      visibilityWhere,
      hashtags,
      queryFts: tagsText,
      queryMatch: tagsText,
      limit,
      cursorPostId,
    });
    const nextCursor = textRes.nextCursor ? `t:${textRes.nextCursor}` : null;
    return { posts: textRes.posts, nextCursor };
  }

  const fetchSize = Math.min(200, limit * 10);
  const useFts = qMatchExpanded.length >= 3;
  let raw: SearchPostRow[] = [];

  if (useFts) {
    const allowedSql = allowed.map((v) => Prisma.sql`${v}::"PostVisibility"`);
    const visibilitySql = viewer?.id
      ? Prisma.sql`AND p."visibility" IN (${Prisma.join(allowedSql)})`
      : Prisma.sql`AND p."visibility" = 'public'`;
    const readableGroupPostSql = host.readableGroupPostSql(viewer);

    const topicsSql =
      topicValues.length > 0
        ? Prisma.sql`OR (p."topics" && ARRAY[${Prisma.join(topicValues.map((t) => Prisma.sql`${t}`))}]::text[])`
        : Prisma.sql``;

    const hashtagOrSql =
      hashtags.length > 0
        ? Prisma.sql`OR (p."hashtags" && ARRAY[${Prisma.join(hashtags.map((t) => Prisma.sql`${t}`))}]::text[])`
        : Prisma.sql``;

    const ids = await host.prisma.$queryRaw<Array<{ id: string }>>(Prisma.sql`
      WITH q AS (SELECT websearch_to_tsquery('english', ${qFtsExpanded}) AS tsq)
      SELECT p."id" as "id"
      FROM "Post" p
      JOIN "User" u ON u."id" = p."userId"
      CROSS JOIN q
      WHERE
        p."deletedAt" IS NULL
        ${readableGroupPostSql}
        ${visibilitySql}
        AND (
          to_tsvector('english', p."body") @@ q.tsq
          OR (
            u."usernameIsSet" = true
            AND to_tsvector(
              'english',
              COALESCE(u."username", '') || ' ' || COALESCE(u."name", '') || ' ' || COALESCE(u."bio", '')
            ) @@ q.tsq
          )
          ${topicsSql}
          ${hashtagOrSql}
        )
      ORDER BY p."createdAt" DESC, p."id" DESC
      LIMIT ${fetchSize}
    `);

    const postIds = ids.map((r) => r.id);
    raw = postIds.length
      ? await host.postsRead.read.findMany({
          where: { id: { in: postIds } },
          include: SEARCH_POST_INCLUDE,
        })
      : [];
  } else {
    const matchWhere = host.postSearchMatchWhere(qMatchExpanded, words);
    const topicWhere: Prisma.PostWhereInput =
      topicValues.length > 0 ? ({ topics: { hasSome: topicValues } } as Prisma.PostWhereInput) : {};
    const baseWhere: Prisma.PostWhereInput =
      hashtags.length > 0
        ? {
            AND: [
              { deletedAt: null },
              readableGroupPostWhere,
              visibilityWhere,
              kindWhere,
              {
                OR: [
                  hashtagWhere,
                  ...(topicValues.length > 0 ? [topicWhere] : []),
                  matchWhere,
                ],
              },
            ],
          }
        : {
            AND: [
              { deletedAt: null },
              readableGroupPostWhere,
              visibilityWhere,
              kindWhere,
              topicValues.length > 0 ? ({ OR: [matchWhere, topicWhere] } as Prisma.PostWhereInput) : matchWhere,
            ],
          };

    raw = await host.postsRead.read.findMany({
      where: baseWhere,
      include: SEARCH_POST_INCLUDE,
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      take: fetchSize,
    });
  }

  // Few hits and no topic recognised: let Jev map the wording to a topic ("gym" -> fitness) and add those posts.
  // Same visibility filters as above, and topics exist only on public, ungrouped posts.
  if (raw.length < TOPIC_RESCUE_BELOW && topicValues.length === 0 && hashtags.length === 0 && phrases.length === 0 && words.length > 0 && qMatchBase.length >= 3) {
    const rescued = await host.jevTopics?.topicsFor(qMatchBase, 'search query').catch(() => null);
    if (rescued?.length) {
      const extra = await host.postsRead.read.findMany({
        where: { AND: [{ deletedAt: null }, readableGroupPostWhere, visibilityWhere, kindWhere, { topics: { hasSome: rescued } }] },
        include: SEARCH_POST_INCLUDE,
        orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
        take: fetchSize,
      });
      const seen = new Set(raw.map((p) => p.id));
      raw = [...raw, ...extra.filter((p) => !seen.has(p.id))];
      topicValues = rescued;
    }
  }

  // Still thin: add posts whose meaning is close to the query. The SQL carries the same visibility and
  // group-readability filters as the keyword search, so a vector never surfaces a post the viewer cannot read.
  const semanticById = new Map<string, number>();
  if (host.embeddings && raw.length < SEMANTIC_RESCUE_BELOW && hashtags.length === 0 && phrases.length === 0 && qMatchBase.length >= 3) {
    const vector = await host.embeddings.embedQuery(qMatchBase);
    if (vector) {
      const allowedSql = allowed.map((v) => Prisma.sql`${v}::"PostVisibility"`);
      const visibilitySql = viewer?.id
        ? Prisma.sql`AND p."visibility" IN (${Prisma.join(allowedSql)})`
        : Prisma.sql`AND p."visibility" = 'public'`;
      const kindSql = kind ? Prisma.sql`AND p."kind" = ${kind}::"PostKind"` : Prisma.sql`AND p."kind" <> 'repost'`;
      const near = await host.embeddings
        .nearestPosts(vector, {
          limit: fetchSize,
          maxDistance: SEMANTIC_MAX_DISTANCE,
          where: Prisma.sql`${host.readableGroupPostSql(viewer)} ${visibilitySql} ${kindSql}`,
        })
        .catch(() => []);
      if (near.length) {
        for (const row of near) semanticById.set(row.id, 1 - row.distance / SEMANTIC_MAX_DISTANCE);
        const have = new Set(raw.map((p) => p.id));
        const missing = near.map((r) => r.id).filter((id) => !have.has(id));
        if (missing.length) {
          const extra = await host.postsRead.read.findMany({ where: { id: { in: missing } }, include: SEARCH_POST_INCLUDE });
          raw = [...raw, ...extra];
        }
      }
    }
  }

  const postIds = raw.map((p) => p.id);
  await host.posts.ensureBoostScoresFresh(postIds);
  const popularityByPostId = await host.posts.computeScoresForPostIds(postIds);

  function postScore(p: (typeof raw)[0]): number {
    const body = (p.body ?? '').trim().toLowerCase();
    const un = (p.user?.username ?? '').trim().toLowerCase();
    const nm = (p.user?.name ?? '').trim().toLowerCase();
    let score = 0;
    if (hashtags.length > 0) {
      const tags = Array.isArray((p as any).hashtags) ? ((p as any).hashtags as string[]) : [];
      if (tags.some((t) => hashtags.includes(String(t)))) score = Math.max(score, POST_SCORE.hashtagMatch);
    }
    if (phraseLowers.length > 0) {
      if (phraseLowers.some((ph) => body.includes(ph))) score = Math.max(score, POST_SCORE.bodyPhrase);
    } else if (qLower && body.includes(qLower)) {
      score = Math.max(score, POST_SCORE.bodyPhrase);
    }
    if (words.length > 0 && words.every((w) => body.includes(w))) score = Math.max(score, POST_SCORE.bodyAllWords);
    if (topicValues.length > 0) {
      const topics = Array.isArray((p as any).topics) ? ((p as any).topics as string[]) : [];
      if (topics.some((t) => topicValues.includes(String(t)))) {
        // A broad subject query should favor posts about that subject over incidental wording.
        const topicScore = words.length === 1 && phraseLowers.length === 0
          ? POST_SCORE.broadTopicMatch : POST_SCORE.topicMatch;
        score = Math.max(score, topicScore);
      }
    }
    if (un === qLower) score = Math.max(score, POST_SCORE.authorExactUsername);
    if (nm === qLower) score = Math.max(score, POST_SCORE.authorExactName);
    if (words.some((w) => body.includes(w))) score = Math.max(score, POST_SCORE.bodyAnyWord);
    if (words.some((w) => un.includes(w))) score = Math.max(score, POST_SCORE.authorUsernameAnyWord);
    if (words.some((w) => nm.includes(w))) score = Math.max(score, POST_SCORE.authorNameAnyWord);
    const closeness = semanticById.get(p.id);
    if (closeness !== undefined) score = Math.max(score, POST_SCORE.semanticBase + closeness * POST_SCORE.semanticSpan);
    return score;
  }

  const sorted = [...raw].sort((a, b) => {
    const relA = postScore(a);
    const relB = postScore(b);
    // For equally relevant broad-topic hits, surface current conversations first.
    if (relA === POST_SCORE.broadTopicMatch && relB === POST_SCORE.broadTopicMatch) {
      const recentFirst = b.createdAt.getTime() - a.createdAt.getTime();
      if (recentFirst) return recentFirst;
    }
    const popA = popularityByPostId.get(a.id) ?? 0;
    const popB = popularityByPostId.get(b.id) ?? 0;
    const scoreA = relA * 10 + Math.log10(1 + popA);
    const scoreB = relB * 10 + Math.log10(1 + popB);
    if (scoreA !== scoreB) return scoreB - scoreA;
    return b.createdAt.getTime() - a.createdAt.getTime() || b.id.localeCompare(a.id);
  });

  const slice = sorted.slice(offset, offset + limit);
  const nextCursor = offset + limit < sorted.length ? String(offset + limit) : null;
  return { posts: slice, nextCursor };
}
