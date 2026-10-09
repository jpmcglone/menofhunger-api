import { Injectable } from '@nestjs/common';
import { createdAtIdBefore } from '../../common/pagination/created-at-id-cursor';
import { SearchScopeService } from './search-scope.service';
import { ArticlesRankingService } from '../articles/articles-ranking.service';
import { PrismaService } from '../prisma/prisma.service';
import { ViewerContextService } from '../viewer/viewer-context.service';
import { BadRequestException, ForbiddenException } from "@nestjs/common";
import { Prisma } from "@prisma/client";
import { ARTICLE_SCORE, SEARCH_ARTICLE_INCLUDE, SEARCH_POST_INCLUDE, extractQuotedPhrases, queryToWords, type SearchArticleBaseRow, type SearchArticleRow } from "./search.shared";
import { toPage, clampLimit } from "../../common/pagination/page";
import { visibleBookmarkedPostWhere, articleSearchMatchWhere } from "./search-where.builders";
import { NOT_DELETED } from '../../common/prisma/where';

@Injectable()
export class SearchContentService {
  constructor(
    private readonly scope: SearchScopeService,
    private readonly articlesRanking: ArticlesRankingService,
    private readonly prisma: PrismaService,
    private readonly viewerContext: ViewerContextService,
  ) {}

  async searchArticles(params: {
      viewerUserId: string | null;
      q: string;
      limit: number;
      cursor: string | null;
    },
  ): Promise<{ articles: SearchArticleRow[]; nextCursor: string | null }> {
    const q = (params.q ?? "").trim();
    if (!q) return { articles: [], nextCursor: null };

    const limit = clampLimit(params.limit, { default: 30, max: 50 });
    const cursor = (params.cursor ?? "").trim() || null;
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
        term: { status: "active" },
      },
      select: { term: { select: { slug: true } } },
      take: 40,
    });
    const taxonomySlugs = new Set(taxonomyAliasTerms.map((r) => r.term.slug));

    const viewer = await this.viewerContext.getViewer(params.viewerUserId ?? null);
    const allowed = this.scope.allowedVisibilitiesForViewer(viewer);
    const baseWhere: Prisma.ArticleWhereInput = {
      ...NOT_DELETED,
      isDraft: false,
      publishedAt: { not: null },
      visibility: { not: "onlyMe" },
    };

    const fetchSize = Math.min(200, limit * 10);
    const useFts = q.length >= 3;
    let raw: SearchArticleBaseRow[] = [];

    if (useFts) {
      const cursorRow = cursor
        ? await this.prisma.article.findUnique({
            where: { id: cursor },
            select: { id: true, publishedAt: true },
          })
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
      const matchWhere = articleSearchMatchWhere(
        q,
        words,
      ) as Prisma.ArticleWhereInput;
      const cursorRow = cursor
        ? await this.prisma.article.findUnique({
            where: { id: cursor },
            select: { id: true, publishedAt: true },
          })
        : null;
      const cursorWhere: Prisma.ArticleWhereInput = cursorRow?.publishedAt
        ? {
            OR: [
              { publishedAt: { lt: cursorRow.publishedAt } },
              {
                AND: [
                  { publishedAt: cursorRow.publishedAt },
                  { id: { lt: cursorRow.id } },
                ],
              },
            ],
          }
        : {};

      raw = await this.prisma.article.findMany({
        where: {
          AND: [baseWhere, cursorWhere, matchWhere],
        },
        include: SEARCH_ARTICLE_INCLUDE,
        orderBy: [{ publishedAt: "desc" }, { id: "desc" }],
        take: fetchSize,
      });
    }

    const articleScore = (a: SearchArticleBaseRow): number => {
      const title = (a.title ?? "").trim().toLowerCase();
      const excerpt = (a.excerpt ?? "").trim().toLowerCase();
      const un = (a.author?.username ?? "").trim().toLowerCase();
      const nm = (a.author?.name ?? "").trim().toLowerCase();
      // Tags come from the joined relation (if included).
      const articleTags =
        (a.tags as Array<{ tag: string }> | undefined) ?? [];
      const tagSlugs = articleTags.map((t) => t.tag.toLowerCase());
      let score = 0;

      // Tag matching: an exact tag hit is the strongest signal — the author explicitly categorized it.
      if (taxonomySlugs.size > 0 && tagSlugs.some((t) => taxonomySlugs.has(t))) {
        score = Math.max(score, ARTICLE_SCORE.tagExact + 5);
      }
      if (tagSlugs.some((t) => t === qLower))
        score = Math.max(score, ARTICLE_SCORE.tagExact);
      else if (qLower && tagSlugs.some((t) => t.startsWith(qLower)))
        score = Math.max(score, ARTICLE_SCORE.tagStartsWith);
      else if (
        words.length > 0 &&
        tagSlugs.some((t) => words.some((w) => t.includes(w)))
      )
        score = Math.max(score, ARTICLE_SCORE.tagStartsWith - 10);

      if (title === qLower) score = Math.max(score, ARTICLE_SCORE.titleExact);
      if (phrases.length > 0) {
        if (phrases.some((p) => title.includes(p)))
          score = Math.max(score, ARTICLE_SCORE.titlePhrase);
        if (phrases.some((p) => excerpt.includes(p)))
          score = Math.max(score, ARTICLE_SCORE.excerptPhrase);
      } else {
        if (qLower && title.includes(qLower))
          score = Math.max(score, ARTICLE_SCORE.titlePhrase);
        if (qLower && excerpt.includes(qLower))
          score = Math.max(score, ARTICLE_SCORE.excerptPhrase);
      }
      if (words.length > 0 && words.every((w) => title.includes(w)))
        score = Math.max(score, ARTICLE_SCORE.titleAllWords);
      if (words.length > 0 && words.every((w) => excerpt.includes(w)))
        score = Math.max(score, ARTICLE_SCORE.excerptAllWords);
      if (un === qLower)
        score = Math.max(score, ARTICLE_SCORE.authorExactUsername);
      if (nm === qLower) score = Math.max(score, ARTICLE_SCORE.authorExactName);
      if (words.some((w) => title.includes(w)))
        score = Math.max(score, ARTICLE_SCORE.titleAnyWord);
      if (words.some((w) => excerpt.includes(w)))
        score = Math.max(score, ARTICLE_SCORE.excerptAnyWord);
      if (words.some((w) => un.includes(w)))
        score = Math.max(score, ARTICLE_SCORE.authorUsernameAnyWord);
      if (words.some((w) => nm.includes(w)))
        score = Math.max(score, ARTICLE_SCORE.authorNameAnyWord);
      return score;
    };

    // Refresh tier-weighted boost scores so popularity discounts unverified boosters
    // (premium 1.25 / verified 1 / everyone else 0.5); falls back to raw boostCount when not yet computed.
    await this.articlesRanking.ensureArticleBoostScoresFresh(
      raw.map((a) => a.id),
    );
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
      const popA =
        boostWeight(a) * 3 + (a.commentCount ?? 0) * 2 + (a.viewCount ?? 0);
      const popB =
        boostWeight(b) * 3 + (b.commentCount ?? 0) * 2 + (b.viewCount ?? 0);
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
      viewerCanAccess:
        allowed.includes(a.visibility) || a.authorId === params.viewerUserId,
    }));
    const nextCursor =
      slice.length > 0 ? (slice[slice.length - 1]?.id ?? null) : null;
    return { articles, nextCursor };
  }

  async searchBookmarks(params: {
      viewerUserId: string | null;
      q: string;
      limit: number;
      cursor: string | null;
      collectionId: string | null;
      unorganized: boolean;
    },
  ) {
    if (!params.viewerUserId)
      throw new ForbiddenException("Log in to view bookmarks.");
    const userId = params.viewerUserId;
    const q = (params.q ?? "").trim();
    const limit = clampLimit(params.limit, { default: 30, max: 50 });
    const cursor = params.cursor ?? null;
    const collectionId =
      (params.collectionId ?? null) ? String(params.collectionId) : null;
    const unorganized = Boolean(params.unorganized);

    if (collectionId && unorganized)
      throw new BadRequestException("Invalid filter combination.");

    const cursorWhere = await this.bookmarkCursorWhere({ userId, cursor });

    const folderWhere: Prisma.BookmarkWhereInput = unorganized
      ? { collections: { none: {} } }
      : collectionId
        ? { collections: { some: { collectionId } } }
        : {};

    const where: Prisma.BookmarkWhereInput = {
      AND: [
        { userId },
        { post: visibleBookmarkedPostWhere(userId) },
        folderWhere,
        ...(cursorWhere ? [cursorWhere] : []),
        q
          ? {
              OR: [
                { post: { body: { contains: q, mode: "insensitive" } } },
                {
                  post: {
                    user: { username: { contains: q, mode: "insensitive" } },
                  },
                },
                {
                  post: { user: { name: { contains: q, mode: "insensitive" } } },
                },
              ],
            }
          : {},
      ],
    };

    const rows = await this.prisma.bookmark.findMany({
      where,
      orderBy: [{ createdAt: "desc" }, { id: "desc" }],
      take: limit + 1,
      select: {
        id: true,
        createdAt: true,
        postId: true,
        collections: { select: { collectionId: true } },
        post: { include: SEARCH_POST_INCLUDE },
      },
    });

    const { items: slice, nextCursor: nextCursor } = toPage(
      rows,
      limit,
      (r) => r.id,
    );

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

  async bookmarkCursorWhere(
    params: { userId: string; cursor: string | null },
  ): Promise<Prisma.BookmarkWhereInput | null> {
    const cursor = (params.cursor ?? '').trim();
    if (!cursor) return null;
    const row = await this.prisma.bookmark.findUnique({ where: { id: cursor }, select: { id: true, createdAt: true, userId: true } });
    if (!row || row.userId !== params.userId) return null;
    return createdAtIdBefore({ createdAt: row.createdAt, id: row.id });
  }
}


