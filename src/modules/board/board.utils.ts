export const BOARD_TITLE_MIN = 3;
export const BOARD_TITLE_MAX = 80;
export const BOARD_MAX_TAGS = 3;
export const BOARD_TAG_MAX_LENGTH = 24;
export const BOARD_THREADS_PER_HOUR = 5;
export const BOARD_DUPLICATE_WINDOW_DAYS = 30;
/** "Top" without a range ranks recent threads only; older ones have decayed out anyway. */
export const BOARD_TOP_LOOKBACK_DAYS = 14;
export const BOARD_TOP_CANDIDATES = 1500;
export const BOARD_COMMENTS_MAX_ROWS = 2000;
export const BOARD_SEED_TAGS = ['ask', 'show', 'hiring'] as const;

const TRACKING_PARAM_RE = /^(utm_[a-z]+|fbclid|gclid|dclid|mc_cid|mc_eid|igshid|ref|ref_src|si)$/i;

export type NormalizedBoardUrl = {
  url: string;
  normalized: string;
  domain: string;
};

/** Validates an http(s) link and returns a cleaned URL, a duplicate-detection key, and its domain. */
export function normalizeBoardUrl(raw: string | null | undefined): NormalizedBoardUrl | null {
  const input = (raw ?? '').trim();
  if (!input) return null;
  let parsed: URL;
  try {
    parsed = new URL(/^[a-z][a-z0-9+.-]*:\/\//i.test(input) ? input : `https://${input}`);
  } catch {
    return null;
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return null;
  if (!parsed.hostname.includes('.')) return null;

  parsed.hash = '';
  for (const key of [...parsed.searchParams.keys()]) {
    if (TRACKING_PARAM_RE.test(key)) parsed.searchParams.delete(key);
  }
  parsed.hostname = parsed.hostname.toLowerCase();

  const domain = parsed.hostname.replace(/^www\./, '');
  const path = parsed.pathname.replace(/\/+$/, '');
  const params = [...parsed.searchParams.entries()].sort(([a], [b]) => a.localeCompare(b));
  const query = params.length ? `?${new URLSearchParams(params).toString()}` : '';

  return {
    url: parsed.toString(),
    normalized: `${domain}${path}${query}`.toLowerCase(),
    domain,
  };
}

/** Lowercase slug for a Board tag (`#Show HN` → `show-hn`). Returns null when nothing usable remains. */
export function slugifyBoardTag(raw: string | null | undefined): string | null {
  const slug = (raw ?? '')
    .trim()
    .replace(/^#+/, '')
    .toLowerCase()
    .replace(/[\s_]+/g, '-')
    .replace(/[^a-z0-9-]/g, '')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '')
    .slice(0, BOARD_TAG_MAX_LENGTH);
  return slug.length >= 2 ? slug : null;
}

export function normalizeBoardTags(raw: readonly string[] | null | undefined): string[] {
  const out: string[] = [];
  for (const t of raw ?? []) {
    const slug = slugifyBoardTag(t);
    if (slug && !out.includes(slug)) out.push(slug);
  }
  return out;
}

/** Hacker News front-page gravity: points / (ageHours + 2)^1.8. */
export function boardHotScore(points: number, createdAt: Date, now: Date = new Date()): number {
  const ageHours = Math.max(0, (now.getTime() - createdAt.getTime()) / 3_600_000);
  return Math.max(0, points) / Math.pow(ageHours + 2, 1.8);
}

export type BoardRange = 'day' | 'week' | 'month' | 'year' | 'all';

export function boardRangeStart(range: BoardRange, now: Date = new Date()): Date | null {
  const day = 86_400_000;
  switch (range) {
    case 'day': return new Date(now.getTime() - day);
    case 'week': return new Date(now.getTime() - 7 * day);
    case 'month': return new Date(now.getTime() - 30 * day);
    case 'year': return new Date(now.getTime() - 365 * day);
    case 'all': return null;
  }
}

export function encodeOffsetCursor(offset: number): string {
  return Buffer.from(`o:${offset}`, 'utf8').toString('base64url');
}

export function decodeOffsetCursor(cursor: string | null | undefined): number {
  const raw = (cursor ?? '').trim();
  if (!raw) return 0;
  try {
    const text = Buffer.from(raw, 'base64url').toString('utf8');
    const n = text.startsWith('o:') ? parseInt(text.slice(2), 10) : NaN;
    return Number.isFinite(n) && n > 0 ? n : 0;
  } catch {
    return 0;
  }
}
