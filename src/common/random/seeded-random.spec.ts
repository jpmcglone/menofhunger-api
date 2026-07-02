import { seededUnitInterval, generateRandomSeed } from './seeded-random';

describe('seededUnitInterval', () => {
  it('is deterministic for the same seed and key', () => {
    expect(seededUnitInterval('abc', 'post-1')).toBe(seededUnitInterval('abc', 'post-1'));
  });

  it('returns values in [0, 1)', () => {
    for (let i = 0; i < 50; i++) {
      const v = seededUnitInterval('seed', `post-${i}`);
      expect(v).toBeGreaterThanOrEqual(0);
      expect(v).toBeLessThan(1);
    }
  });

  it('varies across keys under the same seed', () => {
    const values = new Set(Array.from({ length: 20 }, (_, i) => seededUnitInterval('seed', `post-${i}`)));
    expect(values.size).toBeGreaterThan(1);
  });

  it('varies across seeds for the same key', () => {
    expect(seededUnitInterval('seed-a', 'post-1')).not.toBe(seededUnitInterval('seed-b', 'post-1'));
  });
});

describe('generateRandomSeed', () => {
  it('returns a non-empty string that differs across calls', () => {
    const a = generateRandomSeed();
    const b = generateRandomSeed();
    expect(a.length).toBeGreaterThan(0);
    expect(a).not.toBe(b);
  });
});
