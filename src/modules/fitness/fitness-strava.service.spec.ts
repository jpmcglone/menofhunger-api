import { FitnessStravaService, stravaRawIsComplete } from './fitness-strava.service';

describe('stravaRawIsComplete', () => {
  it('is true only when activity and streams are both present', () => {
    expect(stravaRawIsComplete(null)).toBe(false);
    expect(stravaRawIsComplete({ activity: { id: 1 } })).toBe(false);
    expect(stravaRawIsComplete({ activity: { id: 1 }, streams: { heartrate: [] } })).toBe(true);
  });
});

describe('FitnessStravaService.normalizeActivity', () => {
  const strava = new FitnessStravaService({} as never, {} as never);

  it('stores the activity name and wraps list JSON as raw', () => {
    const normalized = strava.normalizeActivity({
      id: 42,
      type: 'Run',
      sport_type: 'Run',
      start_date: '2026-08-01T06:00:00Z',
      elapsed_time: 2700,
      distance: 8000,
      total_elevation_gain: 120,
      average_speed: 3,
      name: 'Morning Loop',
      calories: 480,
      average_heartrate: 148,
      max_heartrate: 172,
    });

    expect(normalized.name).toBe('Morning Loop');
    expect(normalized.activityType).toBe('run');
    expect(normalized.totalElevationM).toBe(120);
    expect(normalized.stepsCount).toBeNull();
    expect(normalized.rawJson).toEqual({
      activity: expect.objectContaining({ id: 42, name: 'Morning Loop' }),
      streams: null,
    });
  });

  it('reads steps from the activity detail when Strava sends them', () => {
    const normalized = strava.normalizeActivity(
      {
        id: 42,
        type: 'Walk',
        sport_type: 'Walk',
        start_date: '2026-08-01T06:00:00Z',
        elapsed_time: 1800,
        distance: 2100,
        total_elevation_gain: 12,
        average_speed: 1.2,
        name: 'Afternoon Walk',
      },
      { activity: { id: 42, steps: 3412 } },
    );

    expect(normalized.stepsCount).toBe(3412);
  });
});
