import { z } from 'zod';

// ─── Zod schemas ──────────────────────────────────────────────────────────────

export const connectStravaSchema = z.object({
  code: z.string().trim().min(1),
  redirectUri: z.string().url(),
});

export const manualSyncSchema = z.object({
  provider: z.enum(['strava']),
});

export const healthKitActivitySchema = z.object({
  externalId: z.string(),
  activityType: z.enum(['run', 'ride', 'walk', 'swim', 'workout', 'hike', 'yoga', 'other']),
  startedAt: z.string().datetime(),
  endedAt: z.string().datetime().nullable().optional(),
  durationSec: z.number().int().nonnegative(),
  distanceM: z.number().nonnegative().nullable().optional(),
  stepsCount: z.number().int().nonnegative().nullable().optional(),
  calories: z.number().nonnegative().nullable().optional(),
  avgHeartrate: z.number().nonnegative().nullable().optional(),
  maxHeartrate: z.number().nonnegative().nullable().optional(),
  totalElevationM: z.number().nonnegative().nullable().optional(),
  name: z.string().trim().max(500).nullable().optional(),
});

export const healthKitBodyMetricSchema = z.object({
  externalId: z.string(),
  weightKg: z.number().positive(),
  measuredAt: z.string().datetime(),
});

export const healthKitSleepSchema = z.object({
  dayKey: z.string(),
  sleepMinutes: z.number().int().nonnegative(),
});

export const healthKitHrvSchema = z.object({
  dayKey: z.string(),
  hrvMs: z.number().nonnegative(),
});

export const healthKitVo2MaxSchema = z.object({
  externalId: z.string(),
  vo2maxMlKgMin: z.number().positive(),
  measuredAt: z.string().datetime(),
});

export const healthKitDailyStepsSchema = z.object({
  dayKey: z.string(),
  stepsCount: z.number().int().nonnegative(),
});

/** Caps match the iOS HealthKit sync window so a 2-year dump cannot 500 the request. */
export const HEALTHKIT_UPLOAD_LIMITS = {
  activities: 40,
  bodyMetrics: 60,
  vo2maxReadings: 60,
  daySeries: 31,
} as const;

export const uploadHealthKitSchema = z.object({
  activities: z.array(healthKitActivitySchema).max(HEALTHKIT_UPLOAD_LIMITS.activities).optional(),
  bodyMetrics: z.array(healthKitBodyMetricSchema).max(HEALTHKIT_UPLOAD_LIMITS.bodyMetrics).optional(),
  vo2maxReadings: z.array(healthKitVo2MaxSchema).max(HEALTHKIT_UPLOAD_LIMITS.vo2maxReadings).optional(),
  sleepMinutes: z.array(healthKitSleepSchema).max(HEALTHKIT_UPLOAD_LIMITS.daySeries).optional(),
  hrv: z.array(healthKitHrvSchema).max(HEALTHKIT_UPLOAD_LIMITS.daySeries).optional(),
  dailySteps: z.array(healthKitDailyStepsSchema).max(HEALTHKIT_UPLOAD_LIMITS.daySeries).optional(),
});

export const logWeightSchema = z.object({
  weightKg: z.number().positive(),
  measuredAt: z.string().datetime().optional(),
});

export const upsertGoalSchema = z.object({
  kind: z.literal('weight'),
  startKg: z.number().positive().optional(),
  targetKg: z.number().positive(),
});

export const updateUnitsSchema = z.object({
  units: z.enum(['us', 'metric']),
});

export const createSharePostSchema = z.object({
  shareType: z.enum(['activity', 'weight', 'progress', 'vo2max']),
  body: z.string().trim().max(500).default(''),
  visibility: z.enum(['public', 'verifiedOnly', 'premiumOnly', 'onlyMe']).default('verifiedOnly'),
  activityId: z.string().optional(),
  bodyMetricId: z.string().optional(),
  goalId: z.string().optional(),
});
