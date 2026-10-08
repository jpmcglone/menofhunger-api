/** Floor `n` and clamp it to `[min, max]`; non-finite input returns `min`. */
export function clampInt(n: number, min: number, max: number): number {
  if (!Number.isFinite(n)) return min;
  return Math.max(min, Math.min(max, Math.floor(n)));
}
