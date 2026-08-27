import { FitnessIngestService, isSameActivity, type NormalizedActivity } from './fitness-ingest.service';

function walk(override: Partial<NormalizedActivity> = {}): NormalizedActivity {
  return {
    provider: 'apple_health',
    externalId: 'hk-walk-1',
    activityType: 'walk',
    startedAt: new Date('2026-08-20T12:00:00.000Z'),
    endedAt: new Date('2026-08-20T12:40:00.000Z'),
    durationSec: 2400,
    distanceM: 3200,
    effortScore: null,
    stepsCount: null,
    calories: 180,
    avgHeartrate: null,
    maxHeartrate: null,
    totalElevationM: null,
    name: null,
    rawJson: null,
    ...override,
  };
}

describe('isSameActivity', () => {
  it('is true only for the same provider and external id', () => {
    expect(
      isSameActivity(
        { provider: 'apple_health', externalId: 'hk-1' },
        { provider: 'apple_health', externalId: 'hk-1' },
      ),
    ).toBe(true);
    expect(
      isSameActivity(
        { provider: 'apple_health', externalId: 'hk-1' },
        { provider: 'strava', externalId: 'hk-1' },
      ),
    ).toBe(false);
    expect(
      isSameActivity(
        { provider: 'apple_health', externalId: 'hk-1' },
        { provider: 'apple_health', externalId: 'hk-2' },
      ),
    ).toBe(false);
  });
});

describe('FitnessIngestService', () => {
  it('refreshes a canonical workout on re-sync instead of hiding it as a duplicate of itself', async () => {
    const row = { id: 'a1', provider: 'apple_health' as const, externalId: 'hk-walk-1' };
    const update = jest.fn(async () => row);
    const upsert = jest.fn();
    const ingest = new FitnessIngestService({
      fitnessActivity: {
        findMany: jest.fn(async () => []),
        findFirst: jest.fn(async () => row),
        update,
        upsert,
      },
      fitnessDailySummary: { upsert: jest.fn(async () => ({})), findUnique: jest.fn(async () => null) },
    } as never);

    await ingest.upsertActivities('u1', [walk()]);

    expect(update).toHaveBeenCalled();
    const calls = update.mock.calls as unknown as Array<[{ data: Record<string, unknown> }]>;
    expect(calls[0]?.[0]?.data).not.toHaveProperty('dedupedFromId');
    expect(upsert).not.toHaveBeenCalled();
  });

  it('restores activities that were hidden by a self-dedup', async () => {
    const updateMany = jest.fn(async () => ({ count: 1 }));
    const ingest = new FitnessIngestService({
      fitnessActivity: {
        findMany: jest.fn(async () => [
          {
            id: 'a1',
            startedAt: new Date('2026-08-20T12:00:00.000Z'),
            externalId: 'hk-walk-1',
            dedupedFromId: 'hk-walk-1',
          },
        ]),
        updateMany,
      },
    } as never);

    const dates = await ingest.healSelfHiddenActivities('u1');
    expect(dates).toHaveLength(1);
    expect(updateMany).toHaveBeenCalledWith({
      where: { id: { in: ['a1'] } },
      data: { dedupedFromId: null, dedupedFromProvider: null },
    });
  });
});
