import { BadRequestException, ForbiddenException, Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import type { PostVisibility, VerifiedStatus } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { FollowsService } from '../follows/follows.service';
import { PostsService } from '../posts/posts.service';
import { createdAtIdCursorWhere } from '../../common/pagination/created-at-id-cursor';
import { RequestCacheService } from '../../common/cache/request-cache.service';
import { ViewerContextService } from '../viewer/viewer-context.service';
import { queryToTopicValues } from '../../common/topics/topic-utils';
import { HASHTAG_IN_TEXT_DISPLAY_RE, parseHashtagsFromText } from '../../common/hashtags/hashtag-regex';
import { POST_BASE_INCLUDE } from '../../common/prisma-includes/post.include';
import { articleAuthorInclude } from '../../common/dto/article.dto';
import { toCommunityGroupShellDto, type CommunityGroupShellDto } from '../../common/dto/community-group.dto';

/**
 * Search scoring (higher = better). Used for ranking only; tie-breaks: relationship (users), createdAt (posts).
 * Post search: combines text relevance + popularity score (boost + bookmark + comments, time-decayed).
 *
 * Users (profiles):
 * - Exact username: 100 | Exact display name: 95
 * - Username starts with query: 85 | Display name starts with: 80
 * - Username contains: 70 | Display name contains: 65
 * - Bio contains full query (phrase): 60 | Bio contains all query words: 50 | Bio contains any word: 40
 *
 * Posts (mixed feed):
 * - Post body contains full query (phrase): 90 | Body contains all query words: 75
 * - Author exact username: 65 | Author exact display name: 60
 * - Body contains any query word: 45 | Author username contains any word: 35 | Author display name contains any word: 30
 */
const USER_SCORE = {
  exactUsername: 100,
  exactName: 95,
  usernameStartsWith: 85,
  nameStartsWith: 80,
  usernameContains: 70,
  nameContains: 65,
  bioPhrase: 60,
  bioAllWords: 50,
  bioAnyWord: 40,
} as const;

const POST_SCORE = {
  hashtagMatch: 110,
  bodyPhrase: 90,
  bodyAllWords: 75,
  topicMatch: 70,
  authorExactUsername: 65,
  authorExactName: 60,
  bodyAnyWord: 45,
  authorUsernameAnyWord: 35,
  authorNameAnyWord: 30,
} as const;

const ARTICLE_SCORE = {
  tagExact: 120,     // tag slug exactly matches query (e.g. ?q=stoicism → tag "stoicism")
  tagStartsWith: 105, // tag slug starts with query
  titleExact: 110,
  titlePhrase: 100,
  titleAllWords: 90,
  excerptPhrase: 80,
  excerptAllWords: 70,
  authorExactUsername: 65,
  authorExactName: 60,
  titleAnyWord: 50,
  excerptAnyWord: 40,
  authorUsernameAnyWord: 35,
  authorNameAnyWord: 30,
} as const;

type Viewer = { id: string; verifiedStatus: VerifiedStatus; premium: boolean } | null;

const SEARCH_POST_INCLUDE = POST_BASE_INCLUDE;
const SEARCH_ARTICLE_INCLUDE = {
  author: { select: articleAuthorInclude },
  reactions: true,
  tags: { select: { tag: true, label: true }, orderBy: { createdAt: 'asc' as const } },
} as const;

type SearchPostRow = Prisma.PostGetPayload<{
  include: typeof SEARCH_POST_INCLUDE;
}>;
type SearchArticleBaseRow = Prisma.ArticleGetPayload<{
  include: typeof SEARCH_ARTICLE_INCLUDE;
}>;
export type SearchArticleRow = SearchArticleBaseRow & { viewerCanAccess: boolean };

export type SearchUserRow = {
  id: string;
  createdAt: Date;
  username: string | null;
  name: string | null;
  premium: boolean;
  premiumPlus: boolean;
  isOrganization: boolean;
  stewardBadgeEnabled: boolean;
  verifiedStatus: VerifiedStatus;
  avatarKey: string | null;
  avatarUpdatedAt: Date | null;
  relationship: { viewerFollowsUser: boolean; userFollowsViewer: boolean };
  orgMemberships: Array<{ org: { id: string; username: string | null; name: string | null; avatarKey: string | null; avatarUpdatedAt: Date | null } }>;
};

/** Unique, non-empty words from query (lowercase). Used for fuzzy author + body matching (e.g. "john steve" → @john or @steve or body). */
function queryToWords(q: string): string[] {
  const trimmed = (q ?? '').trim().toLowerCase();
  if (!trimmed) return [];
  const words = trimmed.split(/\s+/).filter((w) => w.length > 0);
  return [...new Set(words)];
}

function splitSearchQuery(q: string): { hashtags: string[]; text: string } {
  const raw = (q ?? '').toString();
  const hashtags = parseHashtagsFromText(raw);
  if (!hashtags.length) return { hashtags: [], text: raw.trim() };
  const text = raw.replace(new RegExp(HASHTAG_IN_TEXT_DISPLAY_RE.source, 'g'), ' ').replace(/\s+/g, ' ').trim();
  return { hashtags, text };
}

function extractQuotedPhrases(q: string): string[] {
  const raw = (q ?? '').toString();
  if (!raw.includes('"')) return [];
  const out: string[] = [];
  const re = /"([^"]+)"/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(raw))) {
    const phrase = (m[1] ?? '').trim();
    if (phrase) out.push(phrase);
  }
  return [...new Set(out)];
}

@Injectable()
export class SearchService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly follows: FollowsService,
    private readonly posts: PostsService,
    private readonly requestCache: RequestCacheService,
    private readonly viewerContext: ViewerContextService,
  ) {}

  private allowedVisibilitiesForViewer(viewer: Viewer): PostVisibility[] {
    return this.viewerContext.allowedPostVisibilities(viewer as any);
  }

  async searchUsers(params: {
    q: string;
    limit: number;
    cursor: string | null;
    viewerUserId: string | null;
  }): Promise<{ users: SearchUserRow[]; nextCursor: string | null }> {
    const { text: qText } = splitSearchQuery(params.q ?? '');
    const q = (qText ?? '').trim();
    if (!q) return { users: [], nextCursor: null };
    const limit = Math.max(1, Math.min(50, params.limit || 30));
    const cursor = params.cursor ?? null;
    const viewerUserId = params.viewerUserId ?? null;
    const qLower = q.toLowerCase();
    const words = queryToWords(q);

    // Exclude users that have a block relationship with the viewer (either direction).
    const blockedIds: Set<string> = viewerUserId
      ? await (async () => {
          const rows = await this.prisma.userBlock.findMany({
            where: { OR: [{ blockerId: viewerUserId }, { blockedId: viewerUserId }] },
            select: { blockerId: true, blockedId: true },
          });
          const s = new Set<string>();
          for (const r of rows) s.add(r.blockerId === viewerUserId ? r.blockedId : r.blockerId);
          return s;
        })()
      : new Set<string>();

    const fetchSize = Math.min(limit * 5, 50);
    type RawUser = {
      id: string;
      createdAt: Date;
      username: string | null;
      name: string | null;
      bio: string | null;
      premium: boolean;
      premiumPlus: boolean;
      isOrganization: boolean;
      stewardBadgeEnabled: boolean;
      verifiedStatus: VerifiedStatus;
      avatarKey: string | null;
      avatarUpdatedAt: Date | null;
      lastOnlineAt: Date | null;
    };

    let raw: RawUser[] = [];

    // FTS has better scaling than ILIKE/contains, but it changes semantics (especially for prefixes).
    // Keep substring/prefix matching for single-token queries (mention/autocomplete UX),
    // switch to FTS only for multi-word queries.
    const useFts = q.length >= 3 && words.length >= 2;

    if (useFts) {
      const cursorRow =
        cursor
          ? await this.prisma.user.findUnique({ where: { id: cursor }, select: { id: true, createdAt: true } })
          : null;

      raw = await this.prisma.$queryRaw<RawUser[]>(Prisma.sql`
        WITH q AS (SELECT websearch_to_tsquery('english', ${q}) AS tsq)
        SELECT
          u."id",
          u."createdAt",
          u."username",
          u."name",
          u."bio",
          u."premium",
          u."premiumPlus",
          u."isOrganization",
          u."stewardBadgeEnabled",
          u."verifiedStatus",
          u."avatarKey",
          u."avatarUpdatedAt",
          u."lastOnlineAt"
        FROM "User" u, q
        WHERE
          (u."usernameIsSet" = true OR u."name" IS NOT NULL)
          AND u."bannedAt" IS NULL
          ${
            blockedIds.size > 0
              ? Prisma.sql`AND u."id" NOT IN (${Prisma.join([...blockedIds].map((id) => Prisma.sql`${id}`))})`
              : Prisma.sql``
          }
          AND to_tsvector(
            'english',
            COALESCE(u."username", '') || ' ' || COALESCE(u."name", '') || ' ' || COALESCE(u."bio", '')
          ) @@ q.tsq
          ${
            cursorRow
              ? Prisma.sql`AND (
                  u."createdAt" < ${cursorRow.createdAt}
                  OR (u."createdAt" = ${cursorRow.createdAt} AND u."id" < ${cursorRow.id})
                )`
              : Prisma.sql``
          }
        ORDER BY u."createdAt" DESC, u."id" DESC
        LIMIT ${fetchSize + 1}
      `);
    } else {
      const cursorWhere = await createdAtIdCursorWhere({
        cursor,
        lookup: async (id) => await this.prisma.user.findUnique({ where: { id }, select: { id: true, createdAt: true } }),
      });

      const orConditions: any[] = [
        { username: { contains: q, mode: 'insensitive' as const } },
        { name: { contains: q, mode: 'insensitive' as const } },
        { bio: { not: null, contains: q, mode: 'insensitive' as const } },
      ];
      for (const w of words) {
        if (w === qLower) continue;
        orConditions.push({ username: { contains: w, mode: 'insensitive' as const } });
        orConditions.push({ name: { contains: w, mode: 'insensitive' as const } });
        orConditions.push({ bio: { not: null, contains: w, mode: 'insensitive' as const } });
      }
      const matchClause = { OR: orConditions };
      const nameOnlyMatch = {
        AND: [
          { name: { not: null } },
          { name: { contains: q, mode: 'insensitive' as const } },
        ],
      };
      const blockExclude: Prisma.UserWhereInput =
        blockedIds.size > 0 ? { id: { notIn: [...blockedIds] } } : {};

      const whereWithCursor: Prisma.UserWhereInput = cursorWhere
        ? {
            AND: [
              cursorWhere,
              { bannedAt: null },
              blockExclude,
              {
                OR: [
                  { usernameIsSet: true, ...matchClause },
                  nameOnlyMatch,
                ],
              },
            ],
          }
        : {
            AND: [
              { bannedAt: null },
              blockExclude,
              {
                OR: [
                  { usernameIsSet: true, ...matchClause },
                  nameOnlyMatch,
                ],
              },
            ],
          };

      raw = await this.prisma.user.findMany({
        where: whereWithCursor,
        select: {
          id: true,
          createdAt: true,
          username: true,
          name: true,
          bio: true,
          premium: true,
          premiumPlus: true,
          isOrganization: true,
          stewardBadgeEnabled: true,
          verifiedStatus: true,
          avatarKey: true,
          avatarUpdatedAt: true,
          lastOnlineAt: true,
        },
        orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
        take: fetchSize + 1,
      });
    }

    const userIds = raw.map((u) => u.id);
    const [rel, orgMembershipRows] = await Promise.all([
      this.follows.batchRelationshipForUserIds({ viewerUserId, userIds }),
      userIds.length > 0
        ? this.prisma.userOrgMembership.findMany({
            where: { userId: { in: userIds } },
            select: {
              userId: true,
              org: { select: { id: true, username: true, name: true, avatarKey: true, avatarUpdatedAt: true } },
            },
            orderBy: { createdAt: 'asc' },
          })
        : Promise.resolve([]),
    ]);
    const orgsByUserId = new Map<string, typeof orgMembershipRows>();
    for (const row of orgMembershipRows) {
      if (!orgsByUserId.has(row.userId)) orgsByUserId.set(row.userId, []);
      orgsByUserId.get(row.userId)!.push(row);
    }

    function userScore(u: (typeof raw)[0]): number {
      const un = (u.username ?? '').trim().toLowerCase();
      const nm = (u.name ?? '').trim().toLowerCase();
      const bio = (u.bio ?? '').trim().toLowerCase();
      if (un === qLower) return USER_SCORE.exactUsername;
      if (nm === qLower) return USER_SCORE.exactName;
      if (un && un.startsWith(qLower)) return USER_SCORE.usernameStartsWith;
      if (nm && nm.startsWith(qLower)) return USER_SCORE.nameStartsWith;
      if (un && un.includes(qLower)) return USER_SCORE.usernameContains;
      if (nm && nm.includes(qLower)) return USER_SCORE.nameContains;
      if (bio && bio.includes(qLower)) return USER_SCORE.bioPhrase;
      if (words.length > 0 && words.every((w) => bio.includes(w))) return USER_SCORE.bioAllWords;
      if (words.some((w) => bio.includes(w))) return USER_SCORE.bioAnyWord;
      return 0;
    }
    // Relationship rank: mutuals first, then people who follow you, then people you follow, then strangers.
    const relRank = (id: string) => {
      const vf = rel.viewerFollows.has(id);
      const fv = rel.followsViewer.has(id);
      if (vf && fv) return 0; // mutual
      if (fv) return 1;       // follows you (but you don't follow them)
      if (vf) return 2;       // you follow them (but they don't follow you)
      return 3;               // no relationship
    };

    // Within each rel group, sort by most recently online (nulls last).
    const onlineMs = (u: (typeof raw)[0]) => u.lastOnlineAt?.getTime() ?? 0;

    const sorted = [...raw].sort((a, b) => {
      const sa = userScore(a);
      const sb = userScore(b);
      if (sa !== sb) return sb - sa;
      const ra = relRank(a.id);
      const rb = relRank(b.id);
      if (ra !== rb) return ra - rb;
      const oa = onlineMs(a);
      const ob = onlineMs(b);
      if (oa !== ob) return ob - oa;
      return b.id.localeCompare(a.id);
    });

    const slice = sorted.slice(0, limit);
    const nextCursor = raw.length > fetchSize ? raw[fetchSize]?.id ?? null : null;

    const users: SearchUserRow[] = slice.map((u) => ({
      id: u.id,
      createdAt: u.createdAt,
      username: u.username,
      name: u.name,
      premium: u.premium,
      premiumPlus: u.premiumPlus,
      isOrganization: Boolean(u.isOrganization),
      stewardBadgeEnabled: Boolean(u.stewardBadgeEnabled),
      verifiedStatus: u.verifiedStatus,
      avatarKey: u.avatarKey,
      avatarUpdatedAt: u.avatarUpdatedAt,
      orgMemberships: orgsByUserId.get(u.id) ?? [],
      relationship: {
        viewerFollowsUser: rel.viewerFollows.has(u.id),
        userFollowsViewer: rel.followsViewer.has(u.id),
        viewerPostNotificationsEnabled: rel.viewerBellEnabled.has(u.id),
      },
    }));

    return { users, nextCursor };
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

    // Cursor not used yet (autocomplete doesn't paginate); keep contract for forward-compat.
    void params.cursor;

    const rows = await this.prisma.hashtag.findMany({
      where: qLower ? { tag: { startsWith: qLower } } : {},
      orderBy: [
        { usageCount: 'desc' },
        { tag: 'asc' },
      ],
      take: limit,
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

    return {
      hashtags: rows.map((r) => ({
        value: r.tag,
        label: labelByTag.get(r.tag) ?? r.tag,
        usageCount: r.usageCount ?? 0,
      })),
      nextCursor: null,
    };
  }

  /** Broad match: body or author username/name (phrase + each word) so "john steve" matches @john, @steve, or body. */
  private postSearchMatchWhere(q: string, words: string[]): object {
    const trimmed = (q ?? '').trim();
    if (!trimmed) return {};
    const orConditions: any[] = [
      { body: { contains: trimmed, mode: 'insensitive' as const } },
      { user: { username: { contains: trimmed, mode: 'insensitive' as const } } },
      { user: { name: { contains: trimmed, mode: 'insensitive' as const } } },
    ];
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

    const sorted = [...raw].sort((a, b) => {
      const relA = articleScore(a);
      const relB = articleScore(b);
      const popA = (a.boostCount ?? 0) * 3 + (a.commentCount ?? 0) * 2 + (a.viewCount ?? 0);
      const popB = (b.boostCount ?? 0) * 3 + (b.commentCount ?? 0) * 2 + (b.viewCount ?? 0);
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

  private async fetchHashtagFallbackTextPosts(params: {
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
        ? Prisma.sql`AND (p."visibility" IN (${Prisma.join(allowedSql)}) OR (p."userId" = ${viewer.id} AND p."visibility" = 'onlyMe'))`
        : Prisma.sql`AND p."visibility" = 'public'`;

      const excludeHashtagsSql =
        hashtags.length > 0
          ? Prisma.sql`AND NOT (p."hashtags" && ARRAY[${Prisma.join(hashtags.map((t) => Prisma.sql`${t}`))}]::text[])`
          : Prisma.sql``;

      const cursorRow = cursorPostId
        ? await this.prisma.post.findUnique({ where: { id: cursorPostId }, select: { id: true, createdAt: true } })
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
          AND p."communityGroupId" IS NULL
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
          )
        ORDER BY p."createdAt" DESC, p."id" DESC
        LIMIT ${limit + 1}
      `);

      const sliceIds = ids.slice(0, limit).map((r) => r.id);
      const nextCursor = ids.length > limit ? (sliceIds[sliceIds.length - 1] ?? null) : null;
      if (sliceIds.length === 0) return { posts: [], nextCursor: null };

      const rows = await this.prisma.post.findMany({
        where: { id: { in: sliceIds } },
        include: SEARCH_POST_INCLUDE,
      });
      const byId = new Map(rows.map((r) => [r.id, r] as const));
      const ordered = sliceIds.map((id) => byId.get(id)).filter(Boolean) as SearchPostRow[];
      return { posts: ordered, nextCursor };
    }

    const words = queryToWords(queryMatch);
    const matchWhere = this.postSearchMatchWhere(queryMatch, words) as Prisma.PostWhereInput;
    const cursorWhere = await createdAtIdCursorWhere({
      cursor: cursorPostId,
      lookup: async (id) => await this.prisma.post.findUnique({ where: { id }, select: { id: true, createdAt: true } }),
    });

    const rows = await this.prisma.post.findMany({
      where: {
        AND: [
          { deletedAt: null },
          { communityGroupId: null },
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
    const slice = rows.slice(0, limit);
    const nextCursor = rows.length > limit ? slice[slice.length - 1]?.id ?? null : null;
    return { posts: slice, nextCursor };
  }

  async searchPosts(params: { viewerUserId: string | null; q: string; limit: number; cursor: string | null; kind?: 'regular' | 'checkin' | null }) {
    const rawQ = (params.q ?? '').trim();
    if (!rawQ) return { posts: [], nextCursor: null };
    const limit = Math.max(1, Math.min(50, params.limit || 30));
    const cursor = params.cursor ?? null;
    const kind = params.kind ?? null;
    const { hashtags, text: qText } = splitSearchQuery(rawQ);
    const tagsText = hashtags.join(' ').trim();
    const qFtsExpanded = (qText ? `${qText} ${tagsText}` : tagsText).trim(); // preserve quotes for websearch_to_tsquery
    const qMatchBase = qText.replace(/"/g, ' ').replace(/\s+/g, ' ').trim();
    const qMatchExpanded = (qMatchBase ? `${qMatchBase} ${tagsText}` : tagsText).trim();
    if (!qMatchExpanded && hashtags.length === 0) return { posts: [], nextCursor: null };
    const phrases = extractQuotedPhrases(qText);
    const phraseLowers = phrases.map((p) => p.toLowerCase());
    const words = queryToWords(qMatchExpanded);
    const qLower = qMatchExpanded.toLowerCase();
    const topicValues = queryToTopicValues(qMatchExpanded);

    const viewer = (await this.viewerContext.getViewer(params.viewerUserId ?? null)) as any;
    const allowed = this.allowedVisibilitiesForViewer(viewer);

    // Never include onlyMe posts in search results (even for the viewer).
    const visibilityWhere: Prisma.PostWhereInput = viewer?.id
      ? { visibility: { in: allowed } }
      : { visibility: 'public' };
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

    // Fast path: hashtag-only search should be cheap and index-backed.
    const isHashtagOnly = hashtags.length > 0 && !qMatchBase;
    if (isHashtagOnly) {
      // Support legacy offset cursor (numeric) but prefer createdAt/id cursor for scalability.
      if (cursorIsOffset) {
        const rows = await this.prisma.post.findMany({
          where: {
            AND: [{ deletedAt: null }, { communityGroupId: null }, visibilityWhere, kindWhere, hashtagWhere],
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
            await this.prisma.post.findUnique({
              where: { id },
              select: { id: true, createdAt: true },
            }),
        });

        const rows = await this.prisma.post.findMany({
          where: {
            AND: [
              { deletedAt: null },
              { communityGroupId: null },
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
    const useFts = qMatchExpanded.length >= 3;
    let raw: SearchPostRow[] = [];

    if (useFts) {
      const allowedSql = allowed.map((v) => Prisma.sql`${v}::"PostVisibility"`);
      const visibilitySql = viewer?.id
        ? Prisma.sql`AND (p."visibility" IN (${Prisma.join(allowedSql)}) OR (p."userId" = ${viewer.id} AND p."visibility" = 'onlyMe'))`
        : Prisma.sql`AND p."visibility" = 'public'`;

      const topicsSql =
        topicValues.length > 0
          ? Prisma.sql`OR (p."topics" && ARRAY[${Prisma.join(topicValues.map((t) => Prisma.sql`${t}`))}]::text[])`
          : Prisma.sql``;

      const hashtagOrSql =
        hashtags.length > 0
          ? Prisma.sql`OR (p."hashtags" && ARRAY[${Prisma.join(hashtags.map((t) => Prisma.sql`${t}`))}]::text[])`
          : Prisma.sql``;

      const ids = await this.prisma.$queryRaw<Array<{ id: string }>>(Prisma.sql`
        WITH q AS (SELECT websearch_to_tsquery('english', ${qFtsExpanded}) AS tsq)
        SELECT p."id" as "id"
        FROM "Post" p
        JOIN "User" u ON u."id" = p."userId"
        CROSS JOIN q
        WHERE
          p."deletedAt" IS NULL
          AND p."communityGroupId" IS NULL
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
        ? await this.prisma.post.findMany({
            where: { id: { in: postIds } },
            include: SEARCH_POST_INCLUDE,
          })
        : [];
    } else {
      const matchWhere = this.postSearchMatchWhere(qMatchExpanded, words);
      const topicWhere: Prisma.PostWhereInput =
        topicValues.length > 0 ? ({ topics: { hasSome: topicValues } } as Prisma.PostWhereInput) : {};
      const baseWhere: Prisma.PostWhereInput =
        hashtags.length > 0
          ? {
              AND: [
                { deletedAt: null },
                { communityGroupId: null },
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
                { communityGroupId: null },
                visibilityWhere,
                kindWhere,
                topicValues.length > 0 ? ({ OR: [matchWhere, topicWhere] } as Prisma.PostWhereInput) : matchWhere,
              ],
            };

      raw = await this.prisma.post.findMany({
        where: baseWhere,
        include: SEARCH_POST_INCLUDE,
        orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
        take: fetchSize,
      });
    }

    const postIds = raw.map((p) => p.id);
    await this.posts.ensureBoostScoresFresh(postIds);
    const popularityByPostId = await this.posts.computeScoresForPostIds(postIds);

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
          score = Math.max(score, POST_SCORE.topicMatch);
        }
      }
      if (un === qLower) score = Math.max(score, POST_SCORE.authorExactUsername);
      if (nm === qLower) score = Math.max(score, POST_SCORE.authorExactName);
      if (words.some((w) => body.includes(w))) score = Math.max(score, POST_SCORE.bodyAnyWord);
      if (words.some((w) => un.includes(w))) score = Math.max(score, POST_SCORE.authorUsernameAnyWord);
      if (words.some((w) => nm.includes(w))) score = Math.max(score, POST_SCORE.authorNameAnyWord);
      return score;
    }

    const sorted = [...raw].sort((a, b) => {
      const relA = postScore(a);
      const relB = postScore(b);
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

  async searchCommunityGroups(params: {
    viewerUserId: string | null;
    q: string;
    limit: number;
  }): Promise<{ groups: CommunityGroupShellDto[] }> {
    const q = (params.q ?? '').trim();
    if (q.length < 2) return { groups: [] };
    const lim = Math.min(20, Math.max(1, params.limit));
    const needle = q.slice(0, 200);

    const rows = await this.prisma.communityGroup.findMany({
      where: {
        deletedAt: null,
        OR: [
          { name: { contains: needle, mode: 'insensitive' } },
          { slug: { contains: needle, mode: 'insensitive' } },
          { description: { contains: needle, mode: 'insensitive' } },
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
      };
    }

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

    return {
      users: userResult.users,
      posts: postResult.posts,
      articles: articleResult.articles,
      groups: groupResult.groups,
      nextUserCursor: userResult.nextCursor,
      nextPostCursor: postResult.nextCursor,
      nextArticleCursor: articleResult.nextCursor,
    };
  }

  /** Store a user search for admin/analytics; called when type=all with logged-in user. */
  async recordUserSearch(params: { userId: string; query: string }) {
    const query = (params.query ?? '').trim().slice(0, 200);
    if (!query) return;
    const normalized = query.toLowerCase().replace(/\s+/g, ' ').trim();
    if (!normalized) return;

    // Tight dedupe: skip writing repeated identical searches within a short window.
    const latest = await this.prisma.userSearch.findFirst({
      where: { userId: params.userId },
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      select: { query: true, createdAt: true },
    });
    if (latest) {
      const latestNormalized = String(latest.query ?? '').toLowerCase().replace(/\s+/g, ' ').trim();
      const ageMs = Date.now() - latest.createdAt.getTime();
      if (latestNormalized === normalized && ageMs < 1000 * 60 * 30) return;
    }

    await this.prisma.userSearch.create({
      data: { userId: params.userId, query },
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
        post: {
          include: {
            user: POST_BASE_INCLUDE.user,
            media: { orderBy: { position: 'asc' } },
            mentions: POST_BASE_INCLUDE.mentions,
          },
        },
      },
    });

    const slice = rows.slice(0, limit);
    const nextCursor = rows.length > limit ? slice[slice.length - 1]?.id ?? null : null;

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

