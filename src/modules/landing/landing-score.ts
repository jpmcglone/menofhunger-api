export const ACTIVITY_WINDOW_DAYS = 30;
const RECENCY_HALF_LIFE_HOURS = 48;
const VOLUME_SATURATION_POSTS = 50;

/** 0..1. Recent presence blended with recent posting volume. */
export function scoreActiveMan(
  input: { lastActiveAt: Date | null; recentPostCount: number },
  now: Date,
): number {
  const hours = input.lastActiveAt
    ? Math.max(0, (now.getTime() - input.lastActiveAt.getTime()) / 3_600_000)
    : Number.POSITIVE_INFINITY;
  const recency = Number.isFinite(hours) ? 0.5 ** (hours / RECENCY_HALF_LIFE_HOURS) : 0;
  const volume = Math.min(
    1,
    Math.log10(1 + Math.max(0, input.recentPostCount)) /
      Math.log10(1 + VOLUME_SATURATION_POSTS),
  );
  return 0.55 * recency + 0.45 * volume;
}
