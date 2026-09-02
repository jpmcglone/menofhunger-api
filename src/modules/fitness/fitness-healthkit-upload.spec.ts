import { HEALTHKIT_UPLOAD_LIMITS, uploadHealthKitSchema } from './fitness.controller';

describe('HealthKit upload caps', () => {
  it('rejects a payload larger than the iOS sync window', () => {
    const activities = Array.from({ length: HEALTHKIT_UPLOAD_LIMITS.activities + 1 }, (_, i) => ({
      externalId: `hk-${i}`,
      activityType: 'run' as const,
      startedAt: '2026-09-01T12:00:00.000Z',
      durationSec: 60,
    }));
    const result = uploadHealthKitSchema.safeParse({ activities });
    expect(result.success).toBe(false);
  });

  it('accepts a compact in-window payload and strips client raw', () => {
    const result = uploadHealthKitSchema.parse({
      activities: [
        {
          externalId: 'hk-1',
          activityType: 'run',
          startedAt: '2026-09-01T12:00:00.000Z',
          durationSec: 60,
          raw: { heartrate: new Array(10_000).fill(140) },
        },
      ],
    });
    expect(result.activities).toHaveLength(1);
    expect(result.activities?.[0]).not.toHaveProperty('raw');
  });
});
