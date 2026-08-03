import { scoreActiveMan } from './landing-score';

const NOW = new Date('2026-04-25T12:00:00.000Z');

function hoursAgo(h: number): Date {
  return new Date(NOW.getTime() - h * 3_600_000);
}

describe('scoreActiveMan', () => {
  it('returns 0 for a user with no last active timestamp', () => {
    const score = scoreActiveMan({ lastActiveAt: null, recentPostCount: 0 }, NOW);
    expect(score).toBe(0);
  });

  it('returns a positive score for a user active right now', () => {
    const score = scoreActiveMan({ lastActiveAt: NOW, recentPostCount: 0 }, NOW);
    expect(score).toBeGreaterThan(0);
  });

  it('a recently active prolific user outscores a stale user with the same post count', () => {
    const recent = scoreActiveMan({ lastActiveAt: hoursAgo(1), recentPostCount: 20 }, NOW);
    const stale = scoreActiveMan({ lastActiveAt: hoursAgo(400), recentPostCount: 20 }, NOW);
    expect(recent).toBeGreaterThan(stale);
  });

  it('a recently active prolific user outscores a recently active silent user', () => {
    const prolific = scoreActiveMan({ lastActiveAt: hoursAgo(1), recentPostCount: 30 }, NOW);
    const silent = scoreActiveMan({ lastActiveAt: hoursAgo(1), recentPostCount: 0 }, NOW);
    expect(prolific).toBeGreaterThan(silent);
  });

  it('volume saturates near 1 beyond VOLUME_SATURATION_POSTS', () => {
    const high = scoreActiveMan({ lastActiveAt: null, recentPostCount: 50 }, NOW);
    const higher = scoreActiveMan({ lastActiveAt: null, recentPostCount: 1000 }, NOW);
    // both should produce roughly the same volume component (0.45 * 1), difference < 0.01
    expect(Math.abs(high - higher)).toBeLessThan(0.01);
  });

  it('total score is always in [0, 1]', () => {
    const cases = [
      { lastActiveAt: null, recentPostCount: 0 },
      { lastActiveAt: hoursAgo(0), recentPostCount: 100 },
      { lastActiveAt: hoursAgo(10000), recentPostCount: 0 },
    ];
    for (const c of cases) {
      const s = scoreActiveMan(c, NOW);
      expect(s).toBeGreaterThanOrEqual(0);
      expect(s).toBeLessThanOrEqual(1);
    }
  });

  it('recency decays by half every 48 hours with no post volume', () => {
    const at0 = scoreActiveMan({ lastActiveAt: hoursAgo(0), recentPostCount: 0 }, NOW);
    const at48 = scoreActiveMan({ lastActiveAt: hoursAgo(48), recentPostCount: 0 }, NOW);
    // recency component halves; at0 = 0.55 * 1, at48 = 0.55 * 0.5
    expect(at48).toBeCloseTo(at0 / 2, 5);
  });
});
