import { decodeJsonCursor, encodeJsonCursor } from '../../common/pagination/json-cursor';
/**
 * Keyset cursor for /groups/search pagination. Encodes the (memberCount, id)
 * tuple of the LAST row in the previous page so the next request can
 * `WHERE memberCount < c OR (memberCount = c AND id < lastId)`.
 */
export function encodeGroupCursor(c: { memberCount: number; id: string }): string {
  return encodeJsonCursor(c);
}

export function decodeGroupCursor(
  raw: string | null | undefined,
): { memberCount: number; id: string } | null {
  const parsed = decodeJsonCursor(raw);
  if (typeof parsed?.memberCount !== 'number' || typeof parsed.id !== 'string') return null;
  return { memberCount: parsed.memberCount, id: parsed.id };
}

/** Unique, non-empty, lowercased words from a search query. */
export function queryToWords(q: string): string[] {
  const trimmed = (q ?? '').trim().toLowerCase();
  if (!trimmed) return [];
  return [...new Set(trimmed.split(/\s+/).filter((w) => w.length > 0))];
}

/**
 * Relevance score for a group against a search query. Higher is better; ties
 * are broken by `memberCount` then `id`. The bands are intentionally chunky so
 * a strong signal in one field always beats a weak signal in many — that's
 * what makes "yoga" surface a group named "Yoga" before one whose rules
 * happen to mention yoga in passing.
 *
 * - 100  exact name or slug match
 * -  90  name starts with the query
 * -  85  slug starts with the query
 * -  80  name contains the query (phrase)
 * -  75  slug contains the query (phrase)
 * -  70  every query word appears in the name
 * -  60  description contains the query (phrase)
 * -  50  every query word appears in the description
 * -  45  any query word appears in the name
 * -  40  any query word appears in the slug
 * -  30  any query word appears in the description
 * -  20  any query word appears in the rules
 * -  10  fuzzy/FTS-only match (typo tolerance) — barely surfaces but isn't lost
 */
export function scoreGroupAgainstQuery(
  g: { name?: string | null; slug?: string | null; description?: string | null; rules?: string | null },
  qLower: string,
  words: string[],
): number {
  const name = (g.name ?? '').toLowerCase();
  const slug = (g.slug ?? '').toLowerCase();
  const desc = (g.description ?? '').toLowerCase();
  const rules = (g.rules ?? '').toLowerCase();

  let s = 0;
  if (name === qLower || slug === qLower) s = Math.max(s, 100);
  if (qLower && name.startsWith(qLower)) s = Math.max(s, 90);
  if (qLower && slug.startsWith(qLower)) s = Math.max(s, 85);
  if (qLower && name.includes(qLower)) s = Math.max(s, 80);
  if (qLower && slug.includes(qLower)) s = Math.max(s, 75);
  if (words.length > 0 && words.every((w) => name.includes(w))) s = Math.max(s, 70);
  if (qLower && desc.includes(qLower)) s = Math.max(s, 60);
  if (words.length > 0 && words.every((w) => desc.includes(w))) s = Math.max(s, 50);
  if (words.some((w) => name.includes(w))) s = Math.max(s, 45);
  if (words.some((w) => slug.includes(w))) s = Math.max(s, 40);
  if (words.some((w) => desc.includes(w))) s = Math.max(s, 30);
  if (words.some((w) => rules.includes(w))) s = Math.max(s, 20);
  if (s === 0) s = 10;
  return s;
}
