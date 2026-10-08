/** Clamp an optional page-size input to `[1, max]`, falling back to `default` when absent or invalid. */
export function clampLimit(
  limit: number | null | undefined,
  opts: { default: number; max: number },
): number {
  const n = typeof limit === 'number' && Number.isFinite(limit) ? Math.floor(limit) : opts.default;
  return Math.max(1, Math.min(opts.max, n));
}

/**
 * Turn `limit + 1` fetched rows into a page. When more than `limit` rows came back the extra
 * row is dropped and `nextCursor` is derived from the last returned row.
 */
export function toPage<T>(
  rows: T[],
  limit: number,
  cursorOf: (row: T) => string,
): { items: T[]; nextCursor: string | null } {
  const hasMore = rows.length > limit;
  const items = hasMore ? rows.slice(0, limit) : rows;
  const last = items[items.length - 1];
  return { items, nextCursor: hasMore && last ? cursorOf(last) : null };
}
