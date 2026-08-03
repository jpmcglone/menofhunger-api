/**
 * Run `fn` over `items` with at most `concurrency` in flight, ignoring individual failures.
 *
 * Fan-out loops must never launch one promise per recipient: a 500-follower article publish
 * doing that opens ~2000 concurrent queries and starves the Prisma pool for everything else
 * sharing the process. Bounded batches keep the pool usable while still beating a sequential
 * `for await` loop.
 */
export async function runInBatches<T>(
  items: readonly T[],
  concurrency: number,
  fn: (item: T, index: number) => Promise<void>,
): Promise<{ ok: number; failed: number }> {
  const limit = Math.max(1, Math.floor(concurrency));
  let ok = 0;
  let failed = 0;

  for (let start = 0; start < items.length; start += limit) {
    const slice = items.slice(start, start + limit);
    const results = await Promise.allSettled(slice.map((item, i) => fn(item, start + i)));
    for (const r of results) {
      if (r.status === 'fulfilled') ok += 1;
      else failed += 1;
    }
  }

  return { ok, failed };
}

/** Split `items` into fixed-size chunks. Returns `[]` for an empty input. */
export function chunk<T>(items: readonly T[], size: number): T[][] {
  const step = Math.max(1, Math.floor(size));
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += step) {
    out.push(items.slice(i, i + step));
  }
  return out;
}

/** Default in-flight limit for notification fan-out inside a single job. */
export const FANOUT_CONCURRENCY = 10;
