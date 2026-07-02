/**
 * Deterministic pseudo-random helpers for feed jitter.
 *
 * Given the same (seed, key) pair, `seededUnitInterval` always returns the same
 * float in [0, 1). This lets a feed ranker apply "random" jitter that is stable
 * while a paging session reuses the same seed (no reordering as the user scrolls)
 * but changes on a fresh page-1 request when the caller mints a new seed.
 */

/** xmur3 string hash — used to fold an arbitrary string seed into a 32-bit int. */
function hashStringToSeed(input: string): number {
  let h = 1779033703 ^ input.length;
  for (let i = 0; i < input.length; i++) {
    h = Math.imul(h ^ input.charCodeAt(i), 3432918353);
    h = (h << 13) | (h >>> 19);
  }
  return h >>> 0;
}

/** mulberry32 PRNG — small, fast, good-enough distribution for UI jitter (not crypto). */
function mulberry32(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * Deterministic float in [0, 1) for a given (seed, key) pair. Combines the seed and
 * key into a single hash so distinct keys under the same seed are decorrelated.
 */
export function seededUnitInterval(seed: string, key: string): number {
  const combinedSeed = hashStringToSeed(`${seed}:${key}`);
  return mulberry32(combinedSeed)();
}

/** Generates a fresh random seed string for a new page-1 / refresh request. */
export function generateRandomSeed(): string {
  return Math.random().toString(36).slice(2) + Date.now().toString(36);
}
