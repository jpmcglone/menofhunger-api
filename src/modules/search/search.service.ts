import { EmbeddingsService } from '../embeddings/embeddings.service';
import { BadRequestException, ForbiddenException, Injectable, Optional } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import type { PostVisibility } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { FollowsService } from '../follows/follows.service';
import { PostsService } from '../posts/posts.service';
import { ArticlesRankingService } from '../articles/articles-ranking.service';
import { createdAtIdCursorWhere } from '../../common/pagination/created-at-id-cursor';
import { ViewerContextService } from '../viewer/viewer-context.service';
import { JevTopicsService } from '../typesafe/jev-topics.service';
import { JevSearchIntentService } from '../typesafe/jev-search-intent.service';
import { TickerService } from '../cashtags/ticker.service';
import type { CashtagResultDto } from '../../common/dto';
import { excludeBoardOnlyWhere } from '../posts/posts-query-builders';
import { toCommunityGroupShellDto, type CommunityGroupShellDto } from '../../common/dto/community-group.dto';

import { PostsReadService } from '../posts-read/posts-read.service';
import { searchUsersOn } from './search-users.query';
import { searchPostsOn } from './search-posts.query';
import {
  ARTICLE_SCORE,
  POST_MEDIA_NOTE_MATCH_SQL,
  SEARCH_ARTICLE_INCLUDE,
  SEARCH_POST_INCLUDE,
  extractQuotedPhrases,
  queryToWords,
  type SearchArticleBaseRow,
  type SearchArticleRow,
  type SearchPostRow,
  type SearchUserRow,
  type Viewer,
} from './search.shared';
import { toPage } from '../../common/pagination/page';
import { findInviteBlockingCrewMemberIds } from '../viewer/crew-membership.queries';

export type { SearchArticleRow, SearchUserRow } from './search.shared';

@Injectable()
export class SearchService {
  constructor(
    readonly prisma: PrismaService,
    readonly postsRead: PostsReadService,
    readonly follows: FollowsService,
    readonly posts: PostsService,
    readonly articlesRanking: ArticlesRankingService,
    readonly viewerContext: ViewerContextService,
    readonly ticker: TickerService,
    @Optional() readonly jevTopics?: JevTopicsService,
    @Optional() readonly embeddings?: EmbeddingsService,
    @Optional() readonly jevIntent?: JevSearchIntentService,
  ) {}

  allowedVisibilitiesForViewer(viewer: Viewer): PostVisibility[] {
    return this.viewerContext.allowedPostVisibilities(viewer as any);
  }

  /** Post search scope: readable groups only, and never Board-only rows (the Board has its own search). */
  readableGroupPostWhere(viewer: Viewer): Prisma.PostWhereInput {
    return { AND: [excludeBoardOnlyWhere(), this.readableGroupScopeWhere(viewer)] };
  }

  readableGroupScopeWhere(viewer: Viewer): Prisma.PostWhereInput {
    const viewerUserId = (viewer?.id ?? '').trim();
    if (!viewerUserId) return { communityGroupId: null };

    const groupAccess: Prisma.PostWhereInput[] = [];
    if (viewer?.siteAdmin) {
      groupAccess.push({ communityGroup: { deletedAt: null } });
    } else {
      if (this.viewerContext.isVerified(viewer)) {
        groupAccess.push({ communityGroup: { deletedAt: null, joinPolicy: 'open' } });
      }
      groupAccess.push({
        communityGroup: {
          deletedAt: null,
          members: {
            some: {
              userId: viewerUserId,
              status: 'active',
            },
          },
        },
      });
    }

    return { OR: [{ communityGroupId: null }, ...groupAccess] };
  }

  readableGroupPostSql(viewer: Viewer): Prisma.Sql {
    return Prisma.sql`AND p."boardOnly" = false ${this.readableGroupScopeSql(viewer)}`;
  }

  readableGroupScopeSql(viewer: Viewer): Prisma.Sql {
    const viewerUserId = (viewer?.id ?? '').trim();
    if (!viewerUserId) return Prisma.sql`AND p."communityGroupId" IS NULL`;

    if (viewer?.siteAdmin) {
      return Prisma.sql`
        AND (
          p."communityGroupId" IS NULL
          OR EXISTS (
            SELECT 1
            FROM "CommunityGroup" cg
            WHERE cg."id" = p."communityGroupId"
              AND cg."deletedAt" IS NULL
          )
        )
      `;
    }

    const openGroupSql = this.viewerContext.isVerified(viewer)
      ? Prisma.sql`
          OR EXISTS (
            SELECT 1
            FROM "CommunityGroup" cg
            WHERE cg."id" = p."communityGroupId"
              AND cg."deletedAt" IS NULL
              AND cg."joinPolicy" = 'open'
          )
        `
      : Prisma.sql``;

    return Prisma.sql`
      AND (
        p."communityGroupId" IS NULL
        ${openGroupSql}
        OR EXISTS (
          SELECT 1
          FROM "CommunityGroup" cg
          JOIN "CommunityGroupMember" cgm ON cgm."groupId" = cg."id"
          WHERE cg."id" = p."communityGroupId"
            AND cg."deletedAt" IS NULL
            AND cgm."userId" = ${viewerUserId}
            AND cgm."status" = 'active'
        )
      )
    `;
  }

  /**
   * Users in a crew that blocks new invites. A solo crew member (memberCount === 1) stays
   * inviteable because accepting another crew's invite auto-disbands their old crew.
   */
  async inviteBlockingCrewMemberIds(userIds: string[]): Promise<Set<string>> {
    if (!userIds.length) return new Set();
    return findInviteBlockingCrewMemberIds(this.prisma, userIds);
  }

  async searchUsers(params: {
    q: string;
    limit: number;
    cursor: string | null;
    viewerUserId: string | null;
  }): Promise<{ users: SearchUserRow[]; nextCursor: string | null }> {
    return searchUsersOn(this, params);
  }


  async searchHashtags(params: {
    q: string;
    limit: number;
    cursor: string | null;
  }): Promise<{ hashtags: Array<{ value: string; label: string; usageCount: number }>; nextCursor: string | null }> {
    const raw = (params.q ?? '').trim();
    const limit = Math.max(1, Math.min(50, params.limit || 30));

    const q = raw.startsWith('#') ? raw.slice(1) : raw;
    const qLower = q.toLowerCase();

    // Decode keyset cursor: base64-encoded JSON `{ usageCount: number; tag: string }`.
    let cursorUsageCount: number | null = null;
    let cursorTag: string | null = null;
    if (params.cursor) {
      try {
        const decoded = JSON.parse(Buffer.from(params.cursor, 'base64').toString('utf8')) as {
          usageCount: number;
          tag: string;
        };
        cursorUsageCount = decoded.usageCount;
        cursorTag = decoded.tag;
      } catch {
        // Ignore malformed cursor.
      }
    }

    const cursorWhere: Prisma.HashtagWhereInput =
      cursorUsageCount !== null && cursorTag !== null
        ? {
            OR: [
              { usageCount: { lt: cursorUsageCount } },
              { AND: [{ usageCount: cursorUsageCount }, { tag: { gt: cursorTag } }] },
            ],
          }
        : {};

    const rows = await this.prisma.hashtag.findMany({
      where: qLower
        ? { AND: [{ tag: { startsWith: qLower } }, cursorWhere] }
        : cursorWhere,
      orderBy: [
        { usageCount: 'desc' },
        { tag: 'asc' },
      ],
      take: limit + 1,
      select: { tag: true, usageCount: true },
    });

    const tags = rows.map((r) => r.tag).filter(Boolean);
    const labelByTag = new Map<string, string>();
    if (tags.length > 0) {
      // Variants are the source of truth for display casing.
      // DISTINCT ON picks the highest-count variant per tag (ties -> variant asc).
      const variantRows = await this.prisma.$queryRaw<Array<{ tag: string; variant: string }>>(Prisma.sql`
        SELECT DISTINCT ON (hv."tag")
          hv."tag" as "tag",
          hv."variant" as "variant"
        FROM "HashtagVariant" hv
        WHERE hv."tag" IN (${Prisma.join(tags.map((t) => Prisma.sql`${t}`))})
        ORDER BY hv."tag" ASC, hv."count" DESC, hv."variant" ASC
      `);
      for (const r of variantRows) {
        const t = (r?.tag ?? '').trim();
        const v = (r?.variant ?? '').trim();
        if (t && v) labelByTag.set(t, v);
      }
    }

    const slice = rows.slice(0, limit);
    const hasMore = rows.length > limit;
    const lastRow = slice[slice.length - 1];
    const nextCursor =
      hasMore && lastRow
        ? Buffer.from(JSON.stringify({ usageCount: lastRow.usageCount ?? 0, tag: lastRow.tag })).toString('base64')
        : null;

    return {
      hashtags: slice.map((r) => ({
        value: r.tag,
        label: labelByTag.get(r.tag) ?? r.tag,
        usageCount: r.usageCount ?? 0,
      })),
      nextCursor,
    };
  }

  async searchCashtags(params: {
    q: string;
    limit: number;
  }): Promise<{ cashtags: CashtagResultDto[]; nextCursor: null }> {
    const raw = (params.q ?? '').trim();
    const q = raw.startsWith('$') ? raw.slice(1) : raw;
    const limit = Math.max(1, Math.min(50, params.limit || 10));
    const cashtags = await this.ticker.searchPrefix(q, limit);
    return { cashtags, nextCursor: null };
  }

  /** Files whose Marv-written photo note contains the phrase or any word. Feeds the short-query post match. */
  async mediaNoteKeysFor(q: string, words: string[]): Promise<string[]> {
    const trimmed = (q ?? '').trim();
    if (trimmed.length < 2) return [];
    const terms = [...new Set([trimmed, ...words.filter((w) => w.length >= 2)])];
    try {
      const rows = await this.prisma.mediaSearchNote.findMany({
        where: { OR: terms.map((t) => ({ note: { contains: t, mode: 'insensitive' as const } })) },
        select: { r2Key: true },
        take: 200,
      });
      return rows.map((r) => r.r2Key);
    } catch {
      // Photo notes are a bonus; search keeps working without them.
      return [];
    }
  }

  /** Broad match: body or author username/name (phrase + each word) so "john steve" matches @john, @steve, or body. */
  postSearchMatchWhere(q: string, words: string[], noteKeys: string[] = []): object {
    const trimmed = (q ?? '').trim();
    if (!trimmed) return {};
    const orConditions: any[] = [
      { body: { contains: trimmed, mode: 'insensitive' as const } },
      { user: { username: { contains: trimmed, mode: 'insensitive' as const } } },
      { user: { name: { contains: trimmed, mode: 'insensitive' as const } } },
    ];
    // Photos Marv described: match through the files whose note fits the query.
    if (noteKeys.length > 0) {
      orConditions.push({
        media: { some: { deletedAt: null, OR: [{ r2Key: { in: noteKeys } }, { thumbnailR2Key: { in: noteKeys } }] } },
      });
    }
    for (const w of words) {
      if (w === trimmed.toLowerCase()) continue;
      orConditions.push({ body: { contains: w, mode: 'insensitive' as const } });
      orConditions.push({ user: { username: { contains: w, mode: 'insensitive' as const } } });
      orConditions.push({ user: { name: { contains: w, mode: 'insensitive' as const } } });
    }
    return { OR: orConditions };
  }

  private visibleBookmarkedPostWhere(userId: string): Prisma.PostWhereInput {
    return {
      OR: [
        { communityGroupId: null },
        {
          communityGroup: {
            members: {
              some: {
                userId,
                status: 'active',
              },
            },
          },
        },
      ],
    };
  }

  private articleSearchMatchWhere(q: string, words: string[]): object {
    const trimmed = (q ?? '').trim();
    if (!trimmed) return {};
    const orConditions: any[] = [
      { title: { contains: trimmed, mode: 'insensitive' as const } },
      { excerpt: { contains: trimmed, mode: 'insensitive' as const } },
      { author: { username: { contains: trimmed, mode: 'insensitive' as const } } },
      { author: { name: { contains: trimmed, mode: 'insensitive' as const } } },
    ];
    for (const w of words) {
      if (w === trimmed.toLowerCase()) continue;
      orConditions.push({ title: { contains: w, mode: 'insensitive' as const } });
      orConditions.push({ excerpt: { contains: w, mode: 'insensitive' as const } });
      orConditions.push({ author: { username: { contains: w, mode: 'insensitive' as const } } });
      orConditions.push({ author: { name: { contains: w, mode: 'insensitive' as const } } });
    }
    return { OR: orConditions };
  }

  async searchArticles(params: {
    viewerUserId: string | null;
    q: string;
    limit: number;
    cursor: string | null;
  }): Promise<{ articles: SearchArticleRow[]; nextCursor: string | null }> {
    const q = (params.q ?? '').trim();
    if (!q) return { articles: [], nextCursor: null };

    const limit = Math.max(1, Math.min(50, params.limit || 30));
    const cursor = (params.cursor ?? '').trim() || null;
    const words = queryToWords(q);
    const qLower = q.toLowerCase();
    const phrases = extractQuotedPhrases(q).map((p) => p.toLowerCase());
    const taxonomyAliasTerms = await this.prisma.taxonomyAlias.findMany({
      where: {
        OR: [
          { alias: qLower },
          { alias: { startsWith: qLower } },
          ...words.map((w) => ({ alias: { contains: w } })),
        ],
        term: { status: 'active' },
      },
      select: { term: { select: { slug: true } } },
      take: 40,
    });
    const taxonomySlugs = new Set(taxonomyAliasTerms.map((r) => r.term.slug));

    const viewer = (await this.viewerContext.getViewer(params.viewerUserId ?? null)) as any;
    const allowed = this.allowedVisibilitiesForViewer(viewer);
    const baseWhere: Prisma.ArticleWhereInput = {
      deletedAt: null,
      isDraft: false,
      publishedAt: { not: null },
      visibility: { not: 'onlyMe' },
    };

    const fetchSize = Math.min(200, limit * 10);
    const useFts = q.length >= 3;
    let raw: SearchArticleBaseRow[] = [];

    if (useFts) {
      const cursorRow = cursor
        ? await this.prisma.article.findUnique({ where: { id: cursor }, select: { id: true, publishedAt: true } })
        : null;
      const cursorSql = cursorRow?.publishedAt
        ? Prisma.sql`AND (
            a."publishedAt" < ${cursorRow.publishedAt}
            OR (a."publishedAt" = ${cursorRow.publishedAt} AND a."id" < ${cursorRow.id})
          )`
        : Prisma.sql``;

      const ids = await this.prisma.$queryRaw<Array<{ id: string }>>(Prisma.sql`
        WITH q AS (SELECT websearch_to_tsquery('english', ${q}) AS tsq)
        SELECT a."id" as "id"
        FROM "Article" a
        JOIN "User" u ON u."id" = a."authorId"
        CROSS JOIN q
        WHERE
          a."deletedAt" IS NULL
          AND a."isDraft" = false
          AND a."publishedAt" IS NOT NULL
          AND a."visibility" <> 'onlyMe'
          ${cursorSql}
          AND (
            to_tsvector('english',
              COALESCE(a."title", '') || ' ' || COALESCE(a."excerpt", '') || ' ' ||
              COALESCE((SELECT string_agg(at."label", ' ') FROM "ArticleTag" at WHERE at."articleId" = a."id"), '')
            ) @@ q.tsq
            OR to_tsvector(
              'english',
              COALESCE(u."username", '') || ' ' || COALESCE(u."name", '') || ' ' || COALESCE(u."bio", '')
            ) @@ q.tsq
          )
        ORDER BY a."publishedAt" DESC, a."id" DESC
        LIMIT ${fetchSize}
      `);

      const articleIds = ids.map((r) => r.id);
      raw = articleIds.length
        ? await this.prisma.article.findMany({
            where: { id: { in: articleIds } },
            include: SEARCH_ARTICLE_INCLUDE,
          })
        : [];
    } else {
      const matchWhere = this.articleSearchMatchWhere(q, words) as Prisma.ArticleWhereInput;
      const cursorRow = cursor
        ? await this.prisma.article.findUnique({ where: { id: cursor }, select: { id: true, publishedAt: true } })
        : null;
      const cursorWhere: Prisma.ArticleWhereInput =
        cursorRow?.publishedAt
          ? {
              OR: [
                { publishedAt: { lt: cursorRow.publishedAt } },
                { AND: [{ publishedAt: cursorRow.publishedAt }, { id: { lt: cursorRow.id } }] },
              ],
            }
          : {};

      raw = await this.prisma.article.findMany({
        where: {
          AND: [baseWhere, cursorWhere, matchWhere],
        },
        include: SEARCH_ARTICLE_INCLUDE,
        orderBy: [{ publishedAt: 'desc' }, { id: 'desc' }],
        take: fetchSize,
      });
    }

    const articleScore = (a: SearchArticleBaseRow): number => {
      const title = (a.title ?? '').trim().toLowerCase();
      const excerpt = (a.excerpt ?? '').trim().toLowerCase();
      const un = (a.author?.username ?? '').trim().toLowerCase();
      const nm = (a.author?.name ?? '').trim().toLowerCase();
      // Tags come from the joined relation (if included).
      const articleTags = ((a as any).tags as Array<{ tag: string }> | undefined) ?? [];
      const tagSlugs = articleTags.map((t) => t.tag.toLowerCase());
      let score = 0;

      // Tag matching: an exact tag hit is the strongest signal — the author explicitly categorized it.
      if (taxonomySlugs.size > 0 && tagSlugs.some((t) => taxonomySlugs.has(t))) {
        score = Math.max(score, ARTICLE_SCORE.tagExact + 5);
      }
      if (tagSlugs.some((t) => t === qLower)) score = Math.max(score, ARTICLE_SCORE.tagExact);
      else if (qLower && tagSlugs.some((t) => t.startsWith(qLower))) score = Math.max(score, ARTICLE_SCORE.tagStartsWith);
      else if (words.length > 0 && tagSlugs.some((t) => words.some((w) => t.includes(w)))) score = Math.max(score, ARTICLE_SCORE.tagStartsWith - 10);

      if (title === qLower) score = Math.max(score, ARTICLE_SCORE.titleExact);
      if (phrases.length > 0) {
        if (phrases.some((p) => title.includes(p))) score = Math.max(score, ARTICLE_SCORE.titlePhrase);
        if (phrases.some((p) => excerpt.includes(p))) score = Math.max(score, ARTICLE_SCORE.excerptPhrase);
      } else {
        if (qLower && title.includes(qLower)) score = Math.max(score, ARTICLE_SCORE.titlePhrase);
        if (qLower && excerpt.includes(qLower)) score = Math.max(score, ARTICLE_SCORE.excerptPhrase);
      }
      if (words.length > 0 && words.every((w) => title.includes(w))) score = Math.max(score, ARTICLE_SCORE.titleAllWords);
      if (words.length > 0 && words.every((w) => excerpt.includes(w))) score = Math.max(score, ARTICLE_SCORE.excerptAllWords);
      if (un === qLower) score = Math.max(score, ARTICLE_SCORE.authorExactUsername);
      if (nm === qLower) score = Math.max(score, ARTICLE_SCORE.authorExactName);
      if (words.some((w) => title.includes(w))) score = Math.max(score, ARTICLE_SCORE.titleAnyWord);
      if (words.some((w) => excerpt.includes(w))) score = Math.max(score, ARTICLE_SCORE.excerptAnyWord);
      if (words.some((w) => un.includes(w))) score = Math.max(score, ARTICLE_SCORE.authorUsernameAnyWord);
      if (words.some((w) => nm.includes(w))) score = Math.max(score, ARTICLE_SCORE.authorNameAnyWord);
      return score;
    };

    // Refresh tier-weighted boost scores so popularity discounts unverified boosters
    // (premium 1.25 / verified 1 / everyone else 0.5); falls back to raw boostCount when not yet computed.
    await this.articlesRanking.ensureArticleBoostScoresFresh(raw.map((a) => a.id));
    const refreshedBoostScore = raw.length
      ? new Map(
          (
            await this.prisma.article.findMany({
              where: { id: { in: raw.map((a) => a.id) } },
              select: { id: true, boostScore: true },
            })
          ).map((a) => [a.id, a.boostScore] as const),
        )
      : new Map<string, number | null>();
    const boostWeight = (a: SearchArticleBaseRow): number =>
      refreshedBoostScore.get(a.id) ?? a.boostScore ?? a.boostCount ?? 0;

    const sorted = [...raw].sort((a, b) => {
      const relA = articleScore(a);
      const relB = articleScore(b);
      const popA = boostWeight(a) * 3 + (a.commentCount ?? 0) * 2 + (a.viewCount ?? 0);
      const popB = boostWeight(b) * 3 + (b.commentCount ?? 0) * 2 + (b.viewCount ?? 0);
      const scoreA = relA * 10 + Math.log10(1 + popA);
      const scoreB = relB * 10 + Math.log10(1 + popB);
      if (scoreA !== scoreB) return scoreB - scoreA;
      const ap = a.publishedAt?.getTime() ?? 0;
      const bp = b.publishedAt?.getTime() ?? 0;
      if (ap !== bp) return bp - ap;
      return b.id.localeCompare(a.id);
    });

    const slice = sorted.slice(0, limit);
    const articles: SearchArticleRow[] = slice.map((a) => ({
      ...a,
      viewerCanAccess: allowed.includes(a.visibility) || a.authorId === params.viewerUserId,
    }));
    const nextCursor = slice.length > 0 ? (slice[slice.length - 1]?.id ?? null) : null;
    return { articles, nextCursor };
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
  }): Promise<{ posts: SearchPostRow[]; nextCursor: string | null }> {
    const limit = Math.max(1, Math.min(50, params.limit || 30));
    const queryMatch = (params.queryMatch ?? '').trim();
    const queryFts = (params.queryFts ?? '').trim();
    if (!queryMatch) return { posts: [], nextCursor: null };

    const hashtags = (params.hashtags ?? []).map((t) => String(t).trim().toLowerCase()).filter(Boolean);
    const hashtagWhere: Prisma.PostWhereInput =
      hashtags.length > 0 ? ({ hashtags: { hasSome: hashtags } } as Prisma.PostWhereInput) : {};
    const cursorPostId = (params.cursorPostId ?? '').trim() || null;

    const useFts = queryMatch.length >= 3;
    if (useFts) {
      const viewer = params.viewer;
      const allowed = params.allowed ?? ['public'];
      const allowedSql = allowed.map((v) => Prisma.sql`${v}::"PostVisibility"`);
      const visibilitySql = viewer?.id
        ? Prisma.sql`AND p."visibility" IN (${Prisma.join(allowedSql)})`
        : Prisma.sql`AND p."visibility" = 'public'`;
      const readableGroupPostSql = this.readableGroupPostSql(viewer);

      const excludeHashtagsSql =
        hashtags.length > 0
          ? Prisma.sql`AND NOT (p."hashtags" && ARRAY[${Prisma.join(hashtags.map((t) => Prisma.sql`${t}`))}]::text[])`
          : Prisma.sql``;

      const cursorRow = cursorPostId
        ? await this.postsRead.read.findUnique({ where: { id: cursorPostId }, select: { id: true, createdAt: true } })
        : null;
      const cursorSql = cursorRow
        ? Prisma.sql`AND (
            p."createdAt" < ${cursorRow.createdAt}
            OR (p."createdAt" = ${cursorRow.createdAt} AND p."id" < ${cursorRow.id})
          )`
        : Prisma.sql``;

      const ids = await this.prisma.$queryRaw<Array<{ id: string; createdAt: Date }>>(Prisma.sql`
        WITH q AS (SELECT websearch_to_tsquery('english', ${queryFts}) AS tsq)
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
          )
        ORDER BY p."createdAt" DESC, p."id" DESC
        LIMIT ${limit + 1}
      `);

      const sliceIds = ids.slice(0, limit).map((r) => r.id);
      const nextCursor = ids.length > limit ? (sliceIds[sliceIds.length - 1] ?? null) : null;
      if (sliceIds.length === 0) return { posts: [], nextCursor: null };

      const rows = await this.postsRead.read.findMany({
        where: { id: { in: sliceIds } },
        include: SEARCH_POST_INCLUDE,
      });
      const byId = new Map(rows.map((r) => [r.id, r] as const));
      const ordered = sliceIds.map((id) => byId.get(id)).filter(Boolean) as SearchPostRow[];
      return { posts: ordered, nextCursor };
    }

    const words = queryToWords(queryMatch);
    const matchWhere = this.postSearchMatchWhere(queryMatch, words, await this.mediaNoteKeysFor(queryMatch, words)) as Prisma.PostWhereInput;
    const readableGroupPostWhere = this.readableGroupPostWhere(params.viewer);
    const cursorWhere = await createdAtIdCursorWhere({
      cursor: cursorPostId,
      lookup: async (id) => await this.postsRead.read.findUnique({ where: { id }, select: { id: true, createdAt: true } }),
    });

    const rows = await this.postsRead.read.findMany({
      where: {
        AND: [
          { deletedAt: null },
          readableGroupPostWhere,
          params.visibilityWhere,
          ...(hashtags.length > 0 ? [({ NOT: hashtagWhere } as Prisma.PostWhereInput)] : []),
          ...(cursorWhere ? [cursorWhere] : []),
          matchWhere,
        ],
      },
      include: SEARCH_POST_INCLUDE,
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      take: limit + 1,
    });
    const { items: slice, nextCursor: nextCursor } = toPage(rows, limit, (r) => r.id);
    return { posts: slice, nextCursor };
  }

  async searchPosts(params: { viewerUserId: string | null; q: string; limit: number; cursor: string | null; kind?: 'regular' | 'checkin' | null }) {
    return searchPostsOn(this, params);
  }


  async searchCommunityGroups(params: {
    viewerUserId: string | null;
    q: string;
    limit: number;
  }): Promise<{ groups: CommunityGroupShellDto[] }> {
    const q = (params.q ?? '').trim();
    if (q.length < 2) return { groups: [] };
    const lim = Math.min(20, Math.max(1, params.limit));
    const needle = q.slice(0, 200);

    // Visibility: anonymous can only see open groups.
    // Authenticated users can see open groups OR groups they actively belong to.
    const visibilityWhere: Prisma.CommunityGroupWhereInput = params.viewerUserId
      ? {
          OR: [
            { joinPolicy: 'open' },
            { members: { some: { userId: params.viewerUserId, status: 'active' } } },
          ],
        }
      : { joinPolicy: 'open' };

    const rows = await this.prisma.communityGroup.findMany({
      where: {
        AND: [
          { deletedAt: null },
          visibilityWhere,
          {
            OR: [
              { name: { contains: needle, mode: 'insensitive' } },
              { slug: { contains: needle, mode: 'insensitive' } },
              { description: { contains: needle, mode: 'insensitive' } },
            ],
          },
        ],
      },
      orderBy: [{ memberCount: 'desc' }, { createdAt: 'desc' }],
      take: lim,
    });

    if (!rows.length) return { groups: [] };
    if (!params.viewerUserId) {
      return { groups: rows.map((g) => toCommunityGroupShellDto(g, null)) };
    }
    const memberships = await this.prisma.communityGroupMember.findMany({
      where: { userId: params.viewerUserId, groupId: { in: rows.map((r) => r.id) } },
      select: { groupId: true, status: true, role: true },
    });
    const byGroup = new Map(memberships.map((m) => [m.groupId, m] as const));
    return {
      groups: rows.map((g) => {
        const m = byGroup.get(g.id);
        const viewerMembership = m ? { status: m.status, role: m.role } : null;
        return toCommunityGroupShellDto(g, viewerMembership);
      }),
    };
  }

  async searchMixed(params: {
    viewerUserId: string | null;
    q: string;
    userLimit: number;
    postLimit: number;
    articleLimit: number;
    groupLimit: number;
    userCursor: string | null;
    postCursor: string | null;
    articleCursor: string | null;
    kind: 'regular' | 'checkin' | null;
  }): Promise<{
    users: SearchUserRow[];
    posts: Awaited<ReturnType<SearchService['searchPosts']>>['posts'];
    articles: SearchArticleRow[];
    groups: CommunityGroupShellDto[];
    nextUserCursor: string | null;
    nextPostCursor: string | null;
    nextArticleCursor: string | null;
    gatedResultCount: number;
  }> {
    const q = (params.q ?? '').trim();
    if (q.length < 2) {
      return {
        users: [],
        posts: [],
        articles: [],
        groups: [],
        nextUserCursor: null,
        nextPostCursor: null,
        nextArticleCursor: null,
        gatedResultCount: 0,
      };
    }

    const viewer = params.viewerUserId
      ? await this.viewerContext.getViewer(params.viewerUserId)
      : null;

    // Only compute gated count for anonymous or unverified users (the upsell audience).
    const shouldCountGated = !params.viewerUserId || (viewer && !this.viewerContext.isVerified(viewer as any));

    const [userResult, postResult, articleResult, groupResult] = await Promise.all([
      this.searchUsers({
        q,
        limit: params.userLimit,
        cursor: params.userCursor,
        viewerUserId: params.viewerUserId,
      }),
      this.searchPosts({
        viewerUserId: params.viewerUserId,
        q,
        limit: params.postLimit,
        cursor: params.postCursor,
        kind: params.kind ?? null,
      }),
      this.searchArticles({
        viewerUserId: params.viewerUserId,
        q,
        limit: params.articleLimit,
        cursor: params.articleCursor,
      }),
      this.searchCommunityGroups({
        viewerUserId: params.viewerUserId,
        q,
        limit: params.groupLimit,
      }),
    ]);

    // Count gated (verifiedOnly + premiumOnly) posts and articles excluded for anonymous/unverified viewers.
    // Cheap approximate count from the already-fetched article rows plus a dedicated post count.
    let gatedResultCount = 0;
    if (shouldCountGated && q.length >= 2) {
      const words = queryToWords(q);
      const matchWhere = this.articleSearchMatchWhere(q, words) as Prisma.ArticleWhereInput;
      const [gatedArticleCount, gatedPostCount] = await Promise.all([
        this.prisma.article.count({
          where: {
            AND: [
              { deletedAt: null, isDraft: false, publishedAt: { not: null } },
              { visibility: { in: ['verifiedOnly', 'premiumOnly'] } },
              matchWhere,
            ],
          },
        }),
        this.postsRead.read.count({
          where: {
            AND: [
              { deletedAt: null },
              { visibility: { in: ['verifiedOnly', 'premiumOnly'] } },
              this.postSearchMatchWhere(q, words) as Prisma.PostWhereInput,
            ],
          },
        }),
      ]);
      gatedResultCount = gatedArticleCount + gatedPostCount;
    }

    return {
      users: userResult.users,
      posts: postResult.posts,
      articles: articleResult.articles,
      groups: groupResult.groups,
      nextUserCursor: userResult.nextCursor,
      nextPostCursor: postResult.nextCursor,
      nextArticleCursor: articleResult.nextCursor,
      gatedResultCount,
    };
  }

  /**
   * Store a user search for admin/analytics.
   * Called for typed queries (type=all) or for explicit user/group selections.
   * When a target (userId/groupId) is provided the dedupe key is the target rather than the query text.
   */
  async recordUserSearch(params: { userId: string; query: string; targetUserId?: string | null; targetGroupId?: string | null }) {
    const query = (params.query ?? '').trim().slice(0, 200);
    const targetUserId = params.targetUserId ?? null;
    const targetGroupId = params.targetGroupId ?? null;

    if (targetUserId) {
      // For profile taps: dedupe on the target within 30 min.
      const latest = await this.prisma.userSearch.findFirst({
        where: { userId: params.userId, targetUserId },
        orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
        select: { createdAt: true },
      });
      if (latest && Date.now() - latest.createdAt.getTime() < 1000 * 60 * 30) return;
      await this.prisma.userSearch.create({
        data: { userId: params.userId, query, targetUserId, targetGroupId: null },
      });
      return;
    }

    if (targetGroupId) {
      // For group taps: dedupe on the target within 30 min.
      const latest = await this.prisma.userSearch.findFirst({
        where: { userId: params.userId, targetGroupId },
        orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
        select: { createdAt: true },
      });
      if (latest && Date.now() - latest.createdAt.getTime() < 1000 * 60 * 30) return;
      await this.prisma.userSearch.create({
        data: { userId: params.userId, query, targetUserId: null, targetGroupId },
      });
      return;
    }

    if (!query) return;
    const normalized = query.toLowerCase().replace(/\s+/g, ' ').trim();
    if (!normalized) return;

    // Identical text within 30 min is one search. A shorter or longer prefix
    // is a different search when the client actually ran it.
    const latest = await this.prisma.userSearch.findFirst({
      where: { userId: params.userId, targetUserId: null, targetGroupId: null },
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      select: { query: true, createdAt: true },
    });
    if (latest) {
      const latestNormalized = String(latest.query ?? '').toLowerCase().replace(/\s+/g, ' ').trim();
      const ageMs = Date.now() - latest.createdAt.getTime();
      if (latestNormalized === normalized && ageMs < 1000 * 60 * 30) return;
    }

    await this.prisma.userSearch.create({
      data: { userId: params.userId, query, targetUserId: null, targetGroupId: null },
    });
  }

  private async bookmarkCursorWhere(
    params: { userId: string; cursor: string | null },
  ): Promise<Prisma.BookmarkWhereInput | null> {
    const cursor = (params.cursor ?? '').trim();
    if (!cursor) return null;
    const row = await this.prisma.bookmark.findUnique({ where: { id: cursor }, select: { id: true, createdAt: true, userId: true } });
    if (!row || row.userId !== params.userId) return null;
    return {
      OR: [
        { createdAt: { lt: row.createdAt } },
        { AND: [{ createdAt: row.createdAt }, { id: { lt: row.id } }] },
      ],
    };
  }

  async searchBookmarks(params: {
    viewerUserId: string | null;
    q: string;
    limit: number;
    cursor: string | null;
    collectionId: string | null;
    unorganized: boolean;
  }) {
    if (!params.viewerUserId) throw new ForbiddenException('Log in to view bookmarks.');
    const userId = params.viewerUserId;
    const q = (params.q ?? '').trim();
    const limit = Math.max(1, Math.min(50, params.limit || 30));
    const cursor = params.cursor ?? null;
    const collectionId = (params.collectionId ?? null) ? String(params.collectionId) : null;
    const unorganized = Boolean(params.unorganized);

    if (collectionId && unorganized) throw new BadRequestException('Invalid filter combination.');

    const cursorWhere = await this.bookmarkCursorWhere({ userId, cursor });

    const folderWhere: Prisma.BookmarkWhereInput = unorganized
      ? { collections: { none: {} } }
      : collectionId
        ? { collections: { some: { collectionId } } }
        : {};

    const where: Prisma.BookmarkWhereInput = {
      AND: [
        { userId },
        { post: this.visibleBookmarkedPostWhere(userId) },
        folderWhere,
        ...(cursorWhere ? [cursorWhere] : []),
        q
          ? {
              OR: [
                { post: { body: { contains: q, mode: 'insensitive' } } },
                { post: { user: { username: { contains: q, mode: 'insensitive' } } } },
                { post: { user: { name: { contains: q, mode: 'insensitive' } } } },
              ],
            }
          : {},
      ],
    };

    const rows = await this.prisma.bookmark.findMany({
      where,
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      take: limit + 1,
      select: {
        id: true,
        createdAt: true,
        postId: true,
        collections: { select: { collectionId: true } },
        post: { include: SEARCH_POST_INCLUDE },
      },
    });

    const { items: slice, nextCursor: nextCursor } = toPage(rows, limit, (r) => r.id);

    return {
      bookmarks: slice.map((b) => ({
        bookmarkId: b.id,
        createdAt: b.createdAt.toISOString(),
        collectionIds: (b.collections ?? []).map((c) => c.collectionId),
        post: b.post,
      })),
      nextCursor,
    };
  }
}

