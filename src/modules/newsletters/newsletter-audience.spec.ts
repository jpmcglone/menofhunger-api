import { audienceFilterWhere, dateMinus, parseAudienceFilters } from './newsletter-audience';

const NOW = new Date('2026-08-31T16:00:00.000Z');

describe('newsletter audience filters', () => {
  it('drops invalid and duplicate filters', () => {
    expect(parseAudienceFilters(null)).toEqual([]);
    expect(parseAudienceFilters([{ type: 'inactive', amount: 0, unit: 'days' }])).toEqual([]);
    expect(
      parseAudienceFilters([
        { type: 'inactive', amount: 30, unit: 'days' },
        { type: 'inactive', amount: 7, unit: 'days' },
      ]),
    ).toEqual([]);
  });

  it('keeps a valid stacked set', () => {
    const filters = parseAudienceFilters([
      { type: 'inactive', amount: 30, unit: 'days' },
      { type: 'joined', cmp: 'atLeast', amount: 6, unit: 'months' },
      { type: 'tier', min: 'verified' },
      { type: 'noCheckin', amount: 14, unit: 'days' },
    ]);
    expect(filters).toHaveLength(4);
  });

  it('inactive includes never-seen and lastSeen older than the window', () => {
    const where = audienceFilterWhere({ type: 'inactive', amount: 30, unit: 'days' }, NOW);
    expect(where).toEqual({
      OR: [{ lastSeenAt: null }, { lastSeenAt: { lt: dateMinus(NOW, 30, 'days') } }],
    });
  });

  it('joined atLeast uses createdAt on or before the cutoff', () => {
    const where = audienceFilterWhere(
      { type: 'joined', cmp: 'atLeast', amount: 1, unit: 'years' },
      NOW,
    );
    expect(where).toEqual({ createdAt: { lte: dateMinus(NOW, 1, 'years') } });
  });

  it('joined inTheLast uses createdAt on or after the cutoff', () => {
    const where = audienceFilterWhere(
      { type: 'joined', cmp: 'inTheLast', amount: 2, unit: 'weeks' },
      NOW,
    );
    expect(where).toEqual({ createdAt: { gte: dateMinus(NOW, 2, 'weeks') } });
  });

  it('tier premium is paid only; verified includes blue-check or paid', () => {
    expect(audienceFilterWhere({ type: 'tier', min: 'premium' }, NOW)).toEqual({
      OR: [{ premium: true }, { premiumPlus: true }],
    });
    expect(audienceFilterWhere({ type: 'tier', min: 'verified' }, NOW)).toEqual({
      OR: [{ verifiedStatus: { not: 'none' } }, { premium: true }, { premiumPlus: true }],
    });
  });

  it('noCheckin uses the Eastern day key so streaks match the lodge clock', () => {
    const where = audienceFilterWhere({ type: 'noCheckin', amount: 14, unit: 'days' }, NOW);
    expect(where).toEqual({
      OR: [{ lastCheckinDayKey: null }, { lastCheckinDayKey: { lt: '2026-08-17' } }],
    });
  });
});
