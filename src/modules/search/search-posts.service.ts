import { Inject } from '@nestjs/common';
import { PostsRankingService } from '../posts/posts-ranking.service';
import { Injectable, Optional } from '@nestjs/common';
import type { PostVisibility } from '@prisma/client';
import { SearchScopeService } from './search-scope.service';
import { EmbeddingsService } from '../embeddings/embeddings.service';
import { JevSearchIntentService } from '../typesafe/jev-search-intent.service';
import { JevTopicsService } from '../typesafe/jev-topics.service';
import { PostsReadService } from '../posts-read/posts-read.service';

import { PrismaService } from '../prisma/prisma.service';
import { ViewerContextService } from '../viewer/viewer-context.service';
import { Prisma } from '@prisma/client';
import { POST_BASE_INCLUDE } from '../../common/prisma-includes/post.include';
import { createdAtIdCursorWhere } from '../../common/pagination/created-at-id-cursor';
import { queryToTopicValues } from '../../common/topics/topic-utils';
import { buildPostVisibilityWhere } from '../../common/posts/post-visibility';
import type { SearchIntent } from '../typesafe/jev-search-intent.service';
import { LINK_HITS_CTE_SQL, POST_LINK_PREVIEW_MATCH_SQL, POST_MEDIA_NOTE_MATCH_SQL, POST_SCORE, SEARCH_POST_INCLUDE, noteMatchLevel, SEMANTIC_MAX_DISTANCE, SEMANTIC_RESCUE_BELOW, TOPIC_RESCUE_BELOW, extractQuotedPhrases, queryToWords, splitSearchQuery, type SearchPostRow, type Viewer } from './search.shared';
import { toPage, clampLimit } from '../../common/pagination/page';
import { postSearchMatchWhere } from './search-where.builders';
import { NOT_DELETED } from '../../common/prisma/where';

@Injectable()
export class SearchPostsService {
  constructor(
    private readonly scope: SearchScopeService,
    @Inject(PostsRankingService) private readonly postsRanking: Pick<PostsRankingService, 'ensureBoostScoresFresh' | 'computeScoresForPostIds'>,
    private readonly postsRead: PostsReadService,
    private readonly prisma: PrismaService,
    private readonly viewerContext: ViewerContextService,
    @Optional() private readonly embeddings?: EmbeddingsService,
    @Optional() private readonly jevIntent?: JevSearchIntentService,
    @Optional() private readonly jevTopics?: JevTopicsService,
  ) {}

  async searchPosts(params: { viewerUserId: string | null; q: string; limit: number; cursor: string | null; kind?: 'regular' | 'checkin' | null }) {
    const rawQ = (params.q ?? '').trim();
    if (!rawQ) return { posts: [], nextCursor: null };
    const limit = clampLimit(params.limit, { default: 30, max: 50 });
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

    const viewer = await this.viewerContext.getViewer(params.viewerUserId ?? null);
    const allowed = this.scope.allowedVisibilitiesForViewer(viewer);
    const readableGroupPostWhere = this.scope.readableGroupPostWhere(viewer);

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
          await this.postsRead.findIncludingDeleted({ where: { id }, select: { id: true, createdAt: true } }),
      });

      const rows = await this.postsRead.findMany({
        where: {
          AND: [
            NOT_DELETED,
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

      const { items, nextCursor } = toPage(rows, limit, (r) => `p:${r.id}`);
      return { posts: items, nextCursor };
    }

    // Fast path: hashtag-only search should be cheap and index-backed.
    const isHashtagOnly = hashtags.length > 0 && !qMatchBase;
    if (isHashtagOnly) {
      // Support legacy offset cursor (numeric) but prefer createdAt/id cursor for scalability.
      if (cursorIsOffset) {
        const rows = await this.postsRead.findMany({
          where: {
            AND: [NOT_DELETED, readableGroupPostWhere, visibilityWhere, kindWhere, hashtagWhere],
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
        const { items, nextCursor } = toPage(rows, limit, (r) => `p:${r.id}`);
        return { posts: items, nextCursor };
      }

      // Phase 1: hashtag matches (cursor = `p:<postId>`). Phase 2: text matches (`t:<postId>`) excluding hashtag matches.
      if (!cursorIsTextPhase) {
        const cursorWhere = await createdAtIdCursorWhere({
          cursor: cursorPostId,
          lookup: async (id) =>
            await this.postsRead.findIncludingDeleted({
              where: { id },
              select: { id: true, createdAt: true },
            }),
        });

        const rows = await this.postsRead.findMany({
          where: {
            AND: [
              NOT_DELETED,
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
        const hashtagPage = toPage(rows, limit, (r) => `p:${r.id}`);
        if (hashtagPage.nextCursor !== null) return { posts: hashtagPage.items, nextCursor: hashtagPage.nextCursor };

        // Hashtag matches are exhausted (or fewer than a page): fill with text matches for the tag words.
        const hashtagSlice = rows.slice(0, limit);
        const remaining = Math.max(0, limit - hashtagSlice.length);
        if (remaining === 0) {
          const probe = await this.fetchHashtagFallbackTextPosts({
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

        const textRes = await this.fetchHashtagFallbackTextPosts({
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
      const textRes = await this.fetchHashtagFallbackTextPosts({
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
    // Started now so the Jev call overlaps the keyword query; null (unavailable/slow) keeps default ranking.
    const intentPromise: Promise<SearchIntent | null> =
      this.jevIntent && hashtags.length === 0 && phrases.length === 0 && qMatchBase.length >= 3
        ? this.jevIntent.intentFor(qMatchBase).catch(() => null)
        : Promise.resolve(null);
    const useFts = qMatchExpanded.length >= 3;
    let raw: SearchPostRow[] = [];

    if (useFts) {
      const allowedSql = allowed.map((v) => Prisma.sql`${v}::"PostVisibility"`);
      const visibilitySql = viewer?.id
        ? Prisma.sql`AND p."visibility" IN (${Prisma.join(allowedSql)})`
        : Prisma.sql`AND p."visibility" = 'public'`;
      const readableGroupPostSql = this.scope.readableGroupPostSql(viewer);

      const topicsSql =
        topicValues.length > 0
          ? Prisma.sql`OR (p."topics" && ARRAY[${Prisma.join(topicValues.map((t) => Prisma.sql`${t}`))}]::text[])`
          : Prisma.sql``;

      const hashtagOrSql =
        hashtags.length > 0
          ? Prisma.sql`OR (p."hashtags" && ARRAY[${Prisma.join(hashtags.map((t) => Prisma.sql`${t}`))}]::text[])`
          : Prisma.sql``;

      const ids = await this.prisma.$queryRaw<Array<{ id: string }>>(Prisma.sql`
        WITH q AS (SELECT websearch_to_tsquery('english', ${qFtsExpanded}) AS tsq), ${LINK_HITS_CTE_SQL}
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
            OR ${POST_MEDIA_NOTE_MATCH_SQL}
            OR ${POST_LINK_PREVIEW_MATCH_SQL}
            ${topicsSql}
            ${hashtagOrSql}
          )
        ORDER BY p."createdAt" DESC, p."id" DESC
        LIMIT ${fetchSize}
      `);

      const postIds = ids.map((r) => r.id);
      raw = postIds.length
        ? await this.postsRead.findMany({
            where: { id: { in: postIds } },
            include: SEARCH_POST_INCLUDE,
          })
        : [];
    } else {
      const matchWhere = postSearchMatchWhere(qMatchExpanded, words, await this.scope.mediaNoteKeysFor(qMatchExpanded, words));
      const topicWhere: Prisma.PostWhereInput =
        topicValues.length > 0 ? ({ topics: { hasSome: topicValues } } as Prisma.PostWhereInput) : {};
      const baseWhere: Prisma.PostWhereInput =
        hashtags.length > 0
          ? {
              AND: [
                NOT_DELETED,
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
                NOT_DELETED,
                readableGroupPostWhere,
                visibilityWhere,
                kindWhere,
                topicValues.length > 0 ? ({ OR: [matchWhere, topicWhere] } as Prisma.PostWhereInput) : matchWhere,
              ],
            };

      raw = await this.postsRead.findMany({
        where: baseWhere,
        include: SEARCH_POST_INCLUDE,
        orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
        take: fetchSize,
      });
    }

    // Few hits and no topic recognised: let Jev map the wording to a topic ("gym" -> fitness) and add those posts.
    // Same visibility filters as above, and topics exist only on public, ungrouped posts.
    const intent = await intentPromise;
    // A subject query ("grief", "fasting") is worth topic matching even when keywords found a few posts.
    const topicRescueBelow = intent?.kind === 'topic' ? SEMANTIC_RESCUE_BELOW : TOPIC_RESCUE_BELOW;
    if (raw.length < topicRescueBelow && topicValues.length === 0 && hashtags.length === 0 && phrases.length === 0 && words.length > 0 && qMatchBase.length >= 3) {
      const rescued = await this.jevTopics?.topicsFor(qMatchBase, 'search query').catch(() => null);
      if (rescued?.length) {
        const extra = await this.postsRead.findMany({
          where: { AND: [NOT_DELETED, readableGroupPostWhere, visibilityWhere, kindWhere, { topics: { hasSome: rescued } }] },
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
    if (this.embeddings && raw.length < SEMANTIC_RESCUE_BELOW && hashtags.length === 0 && phrases.length === 0 && qMatchBase.length >= 3) {
      const vector = await this.embeddings.embedQuery(qMatchBase);
      if (vector) {
        const allowedSql = allowed.map((v) => Prisma.sql`${v}::"PostVisibility"`);
        const visibilitySql = viewer?.id
          ? Prisma.sql`AND p."visibility" IN (${Prisma.join(allowedSql)})`
          : Prisma.sql`AND p."visibility" = 'public'`;
        const kindSql = kind ? Prisma.sql`AND p."kind" = ${kind}::"PostKind"` : Prisma.sql`AND p."kind" <> 'repost'`;
        const near = await this.embeddings
          .nearestPosts(vector, {
            limit: fetchSize,
            maxDistance: SEMANTIC_MAX_DISTANCE,
            where: Prisma.sql`${this.scope.readableGroupPostSql(viewer)} ${visibilitySql} ${kindSql}`,
          })
          .catch(() => []);
        if (near.length) {
          for (const row of near) semanticById.set(row.id, 1 - row.distance / SEMANTIC_MAX_DISTANCE);
          const have = new Set(raw.map((p) => p.id));
          const missing = near.map((r) => r.id).filter((id) => !have.has(id));
          if (missing.length) {
            const extra = await this.postsRead.findMany({ where: { id: { in: missing } }, include: SEARCH_POST_INCLUDE });
            raw = [...raw, ...extra];
          }
        }
      }
    }

    // Photo notes Marv wrote: rank a post by how well its note fits, like body text.
    const noteKeys = [...new Set(raw.flatMap((p) => (p.media ?? []).flatMap((m) => [m.r2Key, m.thumbnailR2Key])).filter((k): k is string => Boolean(k)))];
    const noteRows = noteKeys.length
      ? await Promise.resolve()
          .then(() => this.prisma.mediaSearchNote.findMany({ where: { r2Key: { in: noteKeys } }, select: { r2Key: true, note: true } }))
          .catch(() => [])
      : [];
    const noteByKey = new Map(noteRows.map((n) => [n.r2Key, n.note] as const));

    const postIds = raw.map((p) => p.id);
    await this.postsRanking.ensureBoostScoresFresh(postIds);
    const popularityByPostId = await this.postsRanking.computeScoresForPostIds(postIds);

    function postScore(p: (typeof raw)[0]): number {
      const body = (p.body ?? '').trim().toLowerCase();
      const un = (p.user?.username ?? '').trim().toLowerCase();
      const nm = (p.user?.name ?? '').trim().toLowerCase();
      let score = 0;
      if (hashtags.length > 0) {
        const tags = Array.isArray(p.hashtags) ? (p.hashtags as string[]) : [];
        if (tags.some((t) => hashtags.includes(String(t)))) score = Math.max(score, POST_SCORE.hashtagMatch);
      }
      if (phraseLowers.length > 0) {
        if (phraseLowers.some((ph) => body.includes(ph))) score = Math.max(score, POST_SCORE.bodyPhrase);
      } else if (qLower && body.includes(qLower)) {
        score = Math.max(score, POST_SCORE.bodyPhrase);
      }
      if (words.length > 0 && words.every((w) => body.includes(w))) score = Math.max(score, POST_SCORE.bodyAllWords);
      if (topicValues.length > 0) {
        const topics = Array.isArray(p.topics) ? (p.topics as string[]) : [];
        if (topics.some((t) => topicValues.includes(String(t)))) {
          // A broad subject query should favor posts about that subject over incidental wording.
          const topicScore = words.length === 1 && phraseLowers.length === 0
            ? POST_SCORE.broadTopicMatch : POST_SCORE.topicMatch;
          score = Math.max(score, topicScore);
        }
      }
      if (noteByKey.size > 0) {
        for (const m of p.media ?? []) {
          const note = noteByKey.get(m.r2Key ?? '') ?? noteByKey.get(m.thumbnailR2Key ?? '');
          if (!note) continue;
          const level = noteMatchLevel(note, qLower, words);
          if (level === 2) score = Math.max(score, POST_SCORE.bodyAllWords);
          else if (level === 1) score = Math.max(score, POST_SCORE.bodyAnyWord);
        }
      }
      if (un === qLower) score = Math.max(score, POST_SCORE.authorExactUsername);
      if (nm === qLower) score = Math.max(score, POST_SCORE.authorExactName);
      if (words.some((w) => body.includes(w))) score = Math.max(score, POST_SCORE.bodyAnyWord);
      if (words.some((w) => un.includes(w))) score = Math.max(score, POST_SCORE.authorUsernameAnyWord);
      if (words.some((w) => nm.includes(w))) score = Math.max(score, POST_SCORE.authorNameAnyWord);
      const closeness = semanticById.get(p.id);
      if (closeness !== undefined) score = Math.max(score, POST_SCORE.semanticBase + closeness * POST_SCORE.semanticSpan);
      // Person-style queries lean toward that author's posts.
      if (intent?.kind === 'person' && score > 0 && (un === qLower || nm === qLower || words.some((w) => un.includes(w) || nm.includes(w)))) {
        score += POST_SCORE.personIntentBoost;
      }
      return score;
    }

    // "latest"/"today" style queries: fresh posts earn up to recencyBoost, fading over a few days.
    const nowMs = Date.now();
    function recencyBonus(p: (typeof raw)[0]): number {
      if (!intent?.wantsRecent) return 0;
      const ageDays = Math.max(0, (nowMs - p.createdAt.getTime()) / 86_400_000);
      return POST_SCORE.recentIntentBoost * Math.exp(-ageDays / 3);
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
      const scoreA = relA * 10 + Math.log10(1 + popA) + (relA > 0 ? recencyBonus(a) : 0);
      const scoreB = relB * 10 + Math.log10(1 + popB) + (relB > 0 ? recencyBonus(b) : 0);
      if (scoreA !== scoreB) return scoreB - scoreA;
      return b.createdAt.getTime() - a.createdAt.getTime() || b.id.localeCompare(a.id);
    });

    const slice = sorted.slice(offset, offset + limit);
    const nextCursor = offset + limit < sorted.length ? String(offset + limit) : null;
    return { posts: slice, nextCursor };
  }

  async fetchHashtagFallbackTextPosts(params: {
      viewer: Viewer;
      allowed: PostVisibility[];
      visibilityWhere: Prisma.PostWhereInput;
      hashtags: string[];
      queryFts: string;
      queryMatch: string;
      limit: number;
      cursorPostId: string | null;
    },
  ): Promise<{ posts: SearchPostRow[]; nextCursor: string | null }> {
    const limit = clampLimit(params.limit, { default: 30, max: 50 });
    const queryMatch = (params.queryMatch ?? "").trim();
    const queryFts = (params.queryFts ?? "").trim();
    if (!queryMatch) return { posts: [], nextCursor: null };

    const hashtags = (params.hashtags ?? [])
      .map((t) => String(t).trim().toLowerCase())
      .filter(Boolean);
    const hashtagWhere: Prisma.PostWhereInput =
      hashtags.length > 0
        ? ({ hashtags: { hasSome: hashtags } } as Prisma.PostWhereInput)
        : {};
    const cursorPostId = (params.cursorPostId ?? "").trim() || null;

    const useFts = queryMatch.length >= 3;
    if (useFts) {
      const viewer = params.viewer;
      const allowed = params.allowed ?? ["public"];
      const allowedSql = allowed.map((v) => Prisma.sql`${v}::"PostVisibility"`);
      const visibilitySql = viewer?.id
        ? Prisma.sql`AND p."visibility" IN (${Prisma.join(allowedSql)})`
        : Prisma.sql`AND p."visibility" = 'public'`;
      const readableGroupPostSql = this.scope.readableGroupPostSql(viewer);

      const excludeHashtagsSql =
        hashtags.length > 0
          ? Prisma.sql`AND NOT (p."hashtags" && ARRAY[${Prisma.join(hashtags.map((t) => Prisma.sql`${t}`))}]::text[])`
          : Prisma.sql``;

      const cursorRow = cursorPostId
        ? await this.postsRead.findIncludingDeleted({
            where: { id: cursorPostId },
            select: { id: true, createdAt: true },
          })
        : null;
      const cursorSql = cursorRow
        ? Prisma.sql`AND (
            p."createdAt" < ${cursorRow.createdAt}
            OR (p."createdAt" = ${cursorRow.createdAt} AND p."id" < ${cursorRow.id})
          )`
        : Prisma.sql``;

      const ids = await this.prisma.$queryRaw<
        Array<{ id: string; createdAt: Date }>
      >(Prisma.sql`
        WITH q AS (SELECT websearch_to_tsquery('english', ${queryFts}) AS tsq), ${LINK_HITS_CTE_SQL}
        SELECT p."id" as "id", p."createdAt" as "createdAt"
        FROM "Post" p
        JOIN "User" u ON u."id" = p."userId"
        CROSS JOIN q
        WHERE
          p."deletedAt" IS NULL
          ${readableGroupPostSql}
          ${visibilitySql}
          ${excludeHashtagsSql}
          ${cursorSql}
          AND (
            to_tsvector('english', p."body") @@ q.tsq
            OR (
              u."usernameIsSet" = true
              AND to_tsvector(
                'english',
                COALESCE(u."username", '') || ' ' || COALESCE(u."name", '') || ' ' || COALESCE(u."bio", '')
              ) @@ q.tsq
            )
            OR ${POST_MEDIA_NOTE_MATCH_SQL}
            OR ${POST_LINK_PREVIEW_MATCH_SQL}
          )
        ORDER BY p."createdAt" DESC, p."id" DESC
        LIMIT ${limit + 1}
      `);

      const { items: sliceRows, nextCursor } = toPage(ids, limit, (r) => r.id);
      const sliceIds = sliceRows.map((r) => r.id);
      if (sliceIds.length === 0) return { posts: [], nextCursor: null };

      const rows = await this.postsRead.findMany({
        where: { id: { in: sliceIds } },
        include: SEARCH_POST_INCLUDE,
      });
      const byId = new Map(rows.map((r) => [r.id, r] as const));
      const ordered = sliceIds
        .map((id) => byId.get(id))
        .filter(Boolean) as SearchPostRow[];
      return { posts: ordered, nextCursor };
    }

    const words = queryToWords(queryMatch);
    const matchWhere = postSearchMatchWhere(
      queryMatch,
      words,
      await this.scope.mediaNoteKeysFor(queryMatch, words),
    ) as Prisma.PostWhereInput;
    const readableGroupPostWhere = this.scope.readableGroupPostWhere(params.viewer);
    const cursorWhere = await createdAtIdCursorWhere({
      cursor: cursorPostId,
      lookup: async (id) =>
        await this.postsRead.findIncludingDeleted({
          where: { id },
          select: { id: true, createdAt: true },
        }),
    });

    const rows = await this.postsRead.findMany({
      where: {
        AND: [
          NOT_DELETED,
          readableGroupPostWhere,
          params.visibilityWhere,
          ...(hashtags.length > 0
            ? [{ NOT: hashtagWhere } as Prisma.PostWhereInput]
            : []),
          ...(cursorWhere ? [cursorWhere] : []),
          matchWhere,
        ],
      },
      include: SEARCH_POST_INCLUDE,
      orderBy: [{ createdAt: "desc" }, { id: "desc" }],
      take: limit + 1,
    });
    const { items: slice, nextCursor: nextCursor } = toPage(
      rows,
      limit,
      (r) => r.id,
    );
    return { posts: slice, nextCursor };
  }
}



