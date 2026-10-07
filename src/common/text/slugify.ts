/**
 * Slug variants. Each one feeds stored slugs or lookup keys, so its charset, separator
 * handling, and length cap must not change without a data migration.
 */

/** Group and crew handles: ASCII alphanumerics joined by single hyphens, max 72 chars. */
export function slugifyHandle(input: string): string {
  return (input ?? '')
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 72);
}

/** Crew handle, falling back to `crew` when the name has no slug characters. */
export function slugifyCrewHandle(input: string): string {
  return slugifyHandle(input) || 'crew';
}

/** Bookmark collection slug: same charset as handles, no length cap. */
export function slugifyCollectionName(name: string): string {
  return (name ?? '')
    .toString()
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .replace(/-{2,}/g, '-');
}

/** Taxonomy topics: drops non-alphanumerics (keeps hyphens), whitespace becomes hyphens, max 80. */
export function slugifyTopic(raw: string): string {
  return (raw ?? '')
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9\s-]/g, '')
    .replace(/\s+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 80);
}

/** Article titles: keeps word characters (including `_` until collapsed), max 80. */
export function slugifyArticleTitle(text: string): string {
  return text
    .toLowerCase()
    .trim()
    .replace(/[^\w\s-]/g, '')
    .replace(/[\s_-]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .substring(0, 80);
}

/** Board tags: strips leading `#`, max `maxLength`; null when shorter than 2 chars. */
export function slugifyBoardTag(raw: string | null | undefined, maxLength: number): string | null {
  const slug = (raw ?? '')
    .trim()
    .replace(/^#+/, '')
    .toLowerCase()
    .replace(/[\s_]+/g, '-')
    .replace(/[^a-z0-9-]/g, '')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '')
    .slice(0, maxLength);
  return slug.length >= 2 ? slug : null;
}

/** Group channel names: folds accents (NFKD) before slugging, max 80. */
export function slugifyChannelName(value: string): string {
  return value
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 80);
}
