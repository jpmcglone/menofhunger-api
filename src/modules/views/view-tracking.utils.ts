const ANON_ID_MIN_LEN = 12;
const ANON_ID_MAX_LEN = 128;
const ANON_ID_RE = /^[A-Za-z0-9_-]+$/;

export const ANON_VIEW_RECOUNT_WINDOW_MS = 24 * 60 * 60 * 1000;
/** Collapse double-flush races only. Unique viewerCount stays 1; lastSeenAt can move on the next refresh. */
export const LAST_SEEN_REFRESH_WINDOW_MS = 8 * 1000;
/** Same identity can add another total view after this window since lastImpressionAt. */
export const TOTAL_VIEW_RECOUNT_WINDOW_MS = 30 * 1000;
/** Throttle room live-updates for total-only increments (not debounce). */
export const VIEW_ROOM_EMIT_THROTTLE_MS = 2 * 1000;
export const LOGGED_IN_VIEW_WEIGHT = 1;
export const ANON_VIEW_WEIGHT = 0.5;

export function sanitizeAnonViewerId(raw: string | null | undefined): string | null {
  const value = (raw ?? '').trim();
  if (value.length < ANON_ID_MIN_LEN || value.length > ANON_ID_MAX_LEN) return null;
  if (!ANON_ID_RE.test(value)) return null;
  return value;
}

export function cutoffForAnonRecount(now = new Date()): Date {
  return new Date(now.getTime() - ANON_VIEW_RECOUNT_WINDOW_MS);
}

export function cutoffForLastSeenRefresh(now = new Date()): Date {
  return new Date(now.getTime() - LAST_SEEN_REFRESH_WINDOW_MS);
}

export function cutoffForTotalViewRecount(now = new Date()): Date {
  return new Date(now.getTime() - TOTAL_VIEW_RECOUNT_WINDOW_MS);
}
