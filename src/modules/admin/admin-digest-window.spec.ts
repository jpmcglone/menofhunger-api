import { adminDigestActivityWindow } from './admin-digest-window';

describe('adminDigestActivityWindow', () => {
  it('labels Saturday 8am ET as Friday, not Thursday', () => {
    // 2026-09-19 08:00 EDT = 12:00 UTC. The old UTC-midnight "yesterday"
    // trick labeled this Thursday, September 17.
    const window = adminDigestActivityWindow(new Date('2026-09-19T12:00:00.000Z'));
    expect(window.dateLabel).toBe('Friday, September 18');
    expect(window.windowStart.toISOString()).toBe('2026-09-18T04:00:00.000Z');
    expect(window.windowEnd.toISOString()).toBe('2026-09-19T04:00:00.000Z');
    expect(window.windowEnd.getTime() - window.windowStart.getTime()).toBe(24 * 60 * 60 * 1000);
    expect(window.sevenDaysAgo.toISOString()).toBe('2026-09-12T04:00:00.000Z');
  });

  it('stays on the Eastern calendar around UTC midnight', () => {
    const window = adminDigestActivityWindow(new Date('2026-09-19T00:30:00.000Z')); // still Friday evening ET
    expect(window.dateLabel).toBe('Thursday, September 17');
    expect(window.windowStart.toISOString()).toBe('2026-09-17T04:00:00.000Z');
    expect(window.windowEnd.toISOString()).toBe('2026-09-18T04:00:00.000Z');
  });

  it('uses a 23-hour window across the spring-forward night', () => {
    const window = adminDigestActivityWindow(new Date('2026-03-09T12:00:00.000Z')); // 8am EDT Monday
    expect(window.dateLabel).toBe('Sunday, March 8');
    expect(window.windowEnd.getTime() - window.windowStart.getTime()).toBe(23 * 60 * 60 * 1000);
  });
});
