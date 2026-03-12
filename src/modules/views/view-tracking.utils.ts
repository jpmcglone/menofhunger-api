const ANON_ID_MIN_LEN = 12;
const ANON_ID_MAX_LEN = 128;
const ANON_ID_RE = /^[A-Za-z0-9_-]+$/;

export const ANON_VIEW_RECOUNT_WINDOW_MS = 24 * 60 * 60 * 1000;
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
