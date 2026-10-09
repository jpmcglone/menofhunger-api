import { Prisma } from '@prisma/client';
import type { VerifiedStatus } from '@prisma/client';
import { HASHTAG_IN_TEXT_DISPLAY_RE, parseHashtagsFromText } from '../../common/hashtags/hashtag-regex';
import { CASHTAG_IN_TEXT_DISPLAY_RE, parseCashtagCandidatesFromText } from '../../common/cashtags/cashtag-regex';
import type { UserListRelationship } from '../../common/dto/user.dto';
import { POST_LIST_INCLUDE } from '../../common/prisma-includes/post.include';
import { articleAuthorInclude } from '../../common/dto/article.dto';
import type { ViewerContext } from '../viewer/viewer-context.service';

/**
 * Search scoring (higher = better). Used for ranking only; tie-breaks: relationship (users), createdAt (posts).
 * Post search: combines text relevance + popularity score (boost + bookmark + comments, time-decayed).
 *
 * Users (profiles):
 * - Exact username: 100 | Exact display name: 95
 * - Username starts with query: 85
 * - All query words in name (order-independent): 88 | All words in username: 83
 * - Display name starts with full query: 80
 * - Username contains: 70 | Each query word is a prefix of a name-word ("ch gr"→"Chris Griffith"): 76
 * - Display name contains: 65
 * - Bio contains full query (phrase): 60 | Bio contains all query words: 50 | Bio contains any word: 40
 *
 * Posts (mixed feed):
 * - Post body contains full query (phrase): 90 | Body contains all query words: 75
 * - Author exact username: 65 | Author exact display name: 60
 * - Body contains any query word: 45 | Author username contains any word: 35 | Author display name contains any word: 30
 */
export const USER_SCORE = {
  exactUsername: 100,
  exactName: 95,
  usernameStartsWith: 85,
  /** All query words (≥ 2 chars each) appear anywhere in the display name — word-order-independent. */
  nameAllWords: 88,
  /** All query words appear anywhere in the username. */
  usernameAllWords: 83,
  nameStartsWith: 80,
  usernameContains: 70,
  /** Each query word is a prefix of at least one word in the display name (e.g. "ch gr" → "Chris Griffith"). */
  nameWordPrefixes: 76,
  nameContains: 65,
  bioPhrase: 60,
  bioAllWords: 50,
  bioAnyWord: 40,
} as const;

/** A post search returning fewer rows than this is thin enough to try topic matching. */
export const TOPIC_RESCUE_BELOW = 3;
/** Meaning-based matches fill in when wording alone finds fewer than this many posts. */
export const SEMANTIC_RESCUE_BELOW = 10;
/** Cosine distance cutoff for a post to count as about the query. Tuned on live data. */
export const SEMANTIC_MAX_DISTANCE = 0.66;

export const POST_SCORE = {
  hashtagMatch: 110,
  bodyPhrase: 90,
  bodyAllWords: 75,
  topicMatch: 70,
  broadTopicMatch: 95,
  authorExactUsername: 65,
  authorExactName: 60,
  bodyAnyWord: 45,
  authorUsernameAnyWord: 35,
  authorNameAnyWord: 30,
  semanticBase: 40,
  semanticSpan: 20,
  /** Added to a post's relevance when the query looks like a person lookup and the author matches. */
  personIntentBoost: 25,
  /** Max ranking points (in the relevance*10 scale) for a brand-new post on "latest" queries. */
  recentIntentBoost: 200,
} as const;

export const ARTICLE_SCORE = {
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

export type Viewer = Pick<ViewerContext, 'id' | 'verifiedStatus' | 'premium' | 'premiumPlus' | 'siteAdmin'> | null;

// Same shape as the feed so Board, article, fitness, and poll posts render fully in results and bookmarks.
export const SEARCH_POST_INCLUDE = POST_LIST_INCLUDE;

/**
 * True when Marv's note for one of the post's photos matches the query. Embed inside a post FTS
 * query that aliases Post as `p` and the parsed query as `q.tsq`. A video's note is keyed by its poster.
 */
export const POST_MEDIA_NOTE_MATCH_SQL = Prisma.sql`EXISTS (
  SELECT 1 FROM "PostMedia" pm
  JOIN "MediaSearchNote" n ON n."r2Key" IN (pm."r2Key", pm."thumbnailR2Key")
  WHERE pm."postId" = p."id" AND pm."deletedAt" IS NULL
    AND to_tsvector('english', n."note") @@ q.tsq
)`;

/**
 * Bound on matching previews per query (freshest first). With `PostLink` the post side is an indexed
 * join on url, so this only caps a pathological common word; direct body matches are unaffected.
 */
export const LINK_HITS_LIMIT = 5000;

/**
 * Cached link previews (OG title/description/site, X post + quoted post text/author) whose text
 * matches the query. Add as a CTE next to `q` (`, link_hits AS MATERIALIZED (...)`) so the preview
 * table is probed once via `LinkMetadata_preview_fts_idx` (the tsvector expression must stay identical
 * to that index; migration 20261008235000). Joined to posts by url through `PostLink`.
 */
export const LINK_HITS_CTE_SQL = Prisma.sql`link_hits AS MATERIALIZED (
  SELECT lm."url" AS url
  FROM "LinkMetadata" lm CROSS JOIN q
  WHERE to_tsvector('english',
    COALESCE(lm."title", '') || ' ' || COALESCE(lm."description", '') || ' ' || COALESCE(lm."siteName", '') || ' ' ||
    COALESCE(lm."socialPost"->>'text', '') || ' ' || COALESCE(lm."socialPost"#>>'{author,name}', '') || ' ' ||
    COALESCE(lm."socialPost"#>>'{author,handle}', '') || ' ' || COALESCE(lm."socialPost"#>>'{quote,text}', '') || ' ' ||
    COALESCE(lm."socialPost"#>>'{quote,author,name}', '')
  ) @@ q.tsq
  ORDER BY lm."updatedAt" DESC
  LIMIT ${LINK_HITS_LIMIT}
)`;

/**
 * True when one of the post's `PostLink` urls has a matching preview in `link_hits` (indexed on url).
 *
 * TRANSITIONAL FALLBACK (remove after 2026-11-15, once `node scripts/backfill-post-links.mjs` is confirmed
 * on production): a post with NO `PostLink` rows but "http" in its body is matched by scanning the body for
 * the preview url (old rtrim'd form), so production posts predating `PostLink` stay searchable before the
 * backfill runs. It earns its place only until then. Gating keeps it cheap: the NOT EXISTS is a primary-key
 * probe, the `http` check skips bodies with no links, and `link_hits` is bounded. After the backfill only
 * posts whose links were all unparseable reach the scan. To remove: delete the second OR branch and this note,
 * and the legacy case in search.service.spec.ts.
 */
export const POST_LINK_PREVIEW_MATCH_SQL = Prisma.sql`(
  EXISTS (
    SELECT 1 FROM "PostLink" pl JOIN link_hits lh ON lh.url = pl."url" WHERE pl."postId" = p."id"
  )
  OR (
    p."body" LIKE '%http%'
    AND NOT EXISTS (SELECT 1 FROM "PostLink" pl0 WHERE pl0."postId" = p."id")
    AND EXISTS (
      SELECT 1 FROM link_hits lh WHERE rtrim(lh.url, '/') <> '' AND position(rtrim(lh.url, '/') in p."body") > 0
    )
  )
)`;

/** Words of the query found in a photo note: 2 = all (or the whole phrase), 1 = some, 0 = none. */
export function noteMatchLevel(note: string, qLower: string, words: string[]): 0 | 1 | 2 {
  const text = note.toLowerCase();
  if (qLower && text.includes(qLower)) return 2;
  if (words.length > 0 && words.every((w) => text.includes(w))) return 2;
  return words.some((w) => text.includes(w)) ? 1 : 0;
}
export const SEARCH_ARTICLE_INCLUDE = {
  author: { select: articleAuthorInclude },
  reactions: true,
  tags: { select: { tag: true, label: true }, orderBy: { createdAt: 'asc' as const } },
} as const;

export type SearchPostRow = Prisma.PostGetPayload<{
  include: typeof SEARCH_POST_INCLUDE;
}>;
export type SearchArticleBaseRow = Prisma.ArticleGetPayload<{
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
  accountKind?: 'person' | 'page';
  verifiedStatus: VerifiedStatus;
  avatarKey: string | null; avatarVideoKey?: string | null; avatarVideoDurationMs?: number | null;
  avatarUpdatedAt: Date | null;
  relationship: UserListRelationship;
  orgMemberships: Array<{ org: { id: string; username: string | null; name: string | null; avatarKey: string | null; avatarVideoKey?: string | null; avatarVideoDurationMs?: number | null; avatarUpdatedAt: Date | null } }>;
};

/** Unique, non-empty words from query (lowercase). Used for fuzzy author + body matching (e.g. "john steve" → @john or @steve or body). */
export function queryToWords(q: string): string[] {
  const trimmed = (q ?? '').trim().toLowerCase();
  if (!trimmed) return [];
  const words = trimmed.split(/\s+/).filter((w) => w.length > 0);
  return [...new Set(words)];
}

/**
 * Build a prefix-aware `to_tsquery` string from sanitized words.
 * Each word gets a `:*` suffix so partial words match longer lexemes:
 *   ["chris", "grif"] → "chris:* & grif:*"
 *   which matches "Chris Griffith" because `griffith` starts with `grif`.
 * Words are stripped to `[a-z0-9]` only to prevent tsquery injection.
 * Returns null when no words survive sanitization.
 */
export function buildPrefixTsQuery(ws: string[]): string | null {
  const safe = ws
    .map((w) => w.replace(/[^a-z0-9]/g, ''))
    .filter((w) => w.length >= 1);
  if (!safe.length) return null;
  return safe.map((w) => `${w}:*`).join(' & ');
}

export function splitSearchQuery(q: string): { hashtags: string[]; cashtags: string[]; text: string } {
  const raw = (q ?? '').toString();
  const hashtags = parseHashtagsFromText(raw);
  const cashtags = parseCashtagCandidatesFromText(raw);
  if (!hashtags.length && !cashtags.length) return { hashtags: [], cashtags: [], text: raw.trim() };
  let text = raw;
  if (hashtags.length) text = text.replace(new RegExp(HASHTAG_IN_TEXT_DISPLAY_RE.source, 'g'), ' ');
  if (cashtags.length) text = text.replace(new RegExp(CASHTAG_IN_TEXT_DISPLAY_RE.source, 'g'), ' ');
  text = text.replace(/\s+/g, ' ').trim();
  return { hashtags, cashtags, text };
}

export function extractQuotedPhrases(q: string): string[] {
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
