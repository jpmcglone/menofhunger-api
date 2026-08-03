import { chunk, runInBatches } from './batch';

describe('runInBatches', () => {
  it('processes every item and reports successes', async () => {
    const seen: number[] = [];

    const result = await runInBatches([1, 2, 3, 4, 5], 2, async (n) => {
      seen.push(n);
    });

    expect(seen.sort()).toEqual([1, 2, 3, 4, 5]);
    expect(result).toEqual({ ok: 5, failed: 0 });
  });

  // The whole reason this helper exists: unbounded parallelism starves the Prisma pool.
  it('never exceeds the concurrency limit', async () => {
    let inFlight = 0;
    let peak = 0;

    await runInBatches(Array.from({ length: 20 }, (_, i) => i), 3, async () => {
      inFlight += 1;
      peak = Math.max(peak, inFlight);
      await new Promise((r) => setTimeout(r, 1));
      inFlight -= 1;
    });

    expect(peak).toBeLessThanOrEqual(3);
  });

  it('keeps going after a failure and counts it', async () => {
    const result = await runInBatches([1, 2, 3], 2, async (n) => {
      if (n === 2) throw new Error('nope');
    });

    expect(result).toEqual({ ok: 2, failed: 1 });
  });

  it('handles an empty list', async () => {
    expect(await runInBatches([], 5, async () => {})).toEqual({ ok: 0, failed: 0 });
  });

  it('treats a non-positive concurrency as sequential', async () => {
    const result = await runInBatches([1, 2], 0, async () => {});
    expect(result).toEqual({ ok: 2, failed: 0 });
  });

  it('passes the absolute index across batches', async () => {
    const indexes: number[] = [];
    await runInBatches(['a', 'b', 'c', 'd'], 2, async (_item, i) => {
      indexes.push(i);
    });
    expect(indexes.sort()).toEqual([0, 1, 2, 3]);
  });
});

describe('chunk', () => {
  it('splits into fixed-size groups with a short tail', () => {
    expect(chunk([1, 2, 3, 4, 5], 2)).toEqual([[1, 2], [3, 4], [5]]);
  });

  it('returns an empty array for no items', () => {
    expect(chunk([], 10)).toEqual([]);
  });

  it('returns one group when the size exceeds the list', () => {
    expect(chunk([1, 2], 10)).toEqual([[1, 2]]);
  });
});
