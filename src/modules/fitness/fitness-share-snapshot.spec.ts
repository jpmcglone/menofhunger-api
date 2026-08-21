import { vo2maxShareSnapshot } from './fitness-share-snapshot';

describe('vo2maxShareSnapshot', () => {
  const latest = {
    id: 'v-new',
    weightKg: 48.2,
    measuredAt: new Date('2026-08-01T00:00:00.000Z'),
  };

  it('includes the change from the first reading', () => {
    const snapshot = vo2maxShareSnapshot({
      latest,
      first: {
        id: 'v-old',
        weightKg: 45.0,
        measuredAt: new Date('2025-11-01T00:00:00.000Z'),
      },
    });

    expect(snapshot.type).toBe('vo2max')
    if (snapshot.type !== 'vo2max') return
    expect(snapshot.data.vo2maxMlKgMin).toBe(48.2)
    expect(snapshot.data.measuredAt).toBe('2026-08-01T00:00:00.000Z')
    expect(snapshot.data.startVo2maxMlKgMin).toBe(45)
    expect(snapshot.data.startedAt).toBe('2025-11-01T00:00:00.000Z')
    expect(snapshot.data.deltaMlKgMin).toBeCloseTo(3.2, 5)
  });

  it('omits progress when this is the only reading', () => {
    const snapshot = vo2maxShareSnapshot({ latest, first: latest });
    expect(snapshot).toEqual({
      type: 'vo2max',
      data: {
        vo2maxMlKgMin: 48.2,
        measuredAt: '2026-08-01T00:00:00.000Z',
        startVo2maxMlKgMin: null,
        startedAt: null,
        deltaMlKgMin: null,
      },
    });
  });
});
