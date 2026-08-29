import type { FitnessProvider, FitnessActivityType, FitnessShareType, FitnessUnits } from '@prisma/client';

// ─── Connection ──────────────────────────────────────────────────────────────

export type FitnessConnectionDto = {
  provider: FitnessProvider;
  status: string;
  lastSyncAt: string | null;
  lastManualSyncAt: string | null;
  providerUserId: string | null;
};

// ─── Activity ────────────────────────────────────────────────────────────────

export type FitnessActivityDto = {
  id: string;
  provider: FitnessProvider;
  activityType: FitnessActivityType;
  name: string | null;
  startedAt: string;
  endedAt: string | null;
  durationSec: number;
  distanceM: number | null;
  effortScore: number | null;
  stepsCount: number | null;
  calories: number | null;
  avgHeartrate: number | null;
  maxHeartrate: number | null;
  /** Total elevation gain in meters. Populated for Strava; null for Apple Health. */
  totalElevationM: number | null;
};

/** Full activity for the detail page. `raw` is the provider payload (or a normalized fallback). */
export type FitnessActivityDetailDto = FitnessActivityDto & {
  externalId: string;
  raw: unknown;
  units: FitnessUnits;
};

// ─── Daily summary ───────────────────────────────────────────────────────────

export type FitnessDailySummaryDto = {
  dayKey: string;
  stepsCount: number | null;
  workoutMinutes: number | null;
  distanceM: number | null;
  effortScore: number | null;
  /** Only present when the viewer has premium. */
  sleepMinutes?: number | null;
  /** Only present when the viewer has premium. */
  hrvMs?: number | null;
};

/** One day of recorded steps for the Steps trend card. Newest-first on the page. */
export type FitnessStepsDayDto = {
  dayKey: string;
  stepsCount: number;
};

// ─── Body metric ─────────────────────────────────────────────────────────────

export type FitnessBodyMetricDto = {
  id: string;
  /** "weight" | "vo2max" */
  kind: string;
  /** kg for weight; ml/kg/min for vo2max */
  weightKg: number;
  measuredAt: string;
  source: string;
};

// ─── Goal ────────────────────────────────────────────────────────────────────

export type FitnessGoalDto = {
  id: string;
  kind: string;
  startKg: number | null;
  targetKg: number | null;
  startedAt: string;
  completedAt: string | null;
};

// ─── Share snapshot (frozen at share time) ───────────────────────────────────

export type FitnessActivitySnapshotDto = {
  activityType: FitnessActivityType;
  startedAt: string;
  durationSec: number;
  distanceM: number | null;
  effortScore: number | null;
  stepsCount: number | null;
  calories: number | null;
  avgHeartrate: number | null;
  maxHeartrate: number | null;
  totalElevationM: number | null;
};

export type FitnessWeightSnapshotDto = {
  weightKg: number;
  measuredAt: string;
  previousWeightKg: number | null;
  deltaKg: number | null;
};

export type FitnessProgressSnapshotDto = {
  startKg: number | null;
  currentKg: number | null;
  targetKg: number | null;
  startedAt: string;
};

export type FitnessVo2MaxSnapshotDto = {
  vo2maxMlKgMin: number;
  measuredAt: string;
  /** Oldest stored reading when there is a prior sample; otherwise null. */
  startVo2maxMlKgMin: number | null;
  startedAt: string | null;
  /** Latest minus start. Null when this is the only reading. */
  deltaMlKgMin: number | null;
};

export type FitnessShareSnapshotDto =
  | { type: 'activity'; data: FitnessActivitySnapshotDto }
  | { type: 'weight'; data: FitnessWeightSnapshotDto }
  | { type: 'progress'; data: FitnessProgressSnapshotDto }
  | { type: 'vo2max'; data: FitnessVo2MaxSnapshotDto };

// ─── Share preview (embedded in post DTO) ────────────────────────────────────

export type FitnessSharePreviewDto = {
  id: string;
  shareType: FitnessShareType;
  snapshot: FitnessShareSnapshotDto;
};

// ─── Summary page ────────────────────────────────────────────────────────────

export type FitnessWeekSummaryDto = {
  weekStart: string;
  weekEnd: string;
  totalSteps: number;
  totalWorkoutMinutes: number;
  totalDistanceM: number;
  /** Sum of effort scores across all activities this week. */
  totalEffort: number;
  /** Number of distinct workout sessions this week. */
  activityCount: number;
  days: FitnessDailySummaryDto[];
};

export type FitnessPageDto = {
  connections: FitnessConnectionDto[];
  weekSummary: FitnessWeekSummaryDto;
  recentActivities: FitnessActivityDto[];
  units: FitnessUnits;
  /** True when the viewer has the 'fitnessStrava' feature toggle and can connect Strava. */
  stravaEnabled: boolean;
  latestWeight: FitnessBodyMetricDto | null;
  /** Up to 60 weight entries newest-first, for the sparkline + history list. */
  weightHistory: FitnessBodyMetricDto[];
  /** Most recent VO2 max reading, or null if none recorded. */
  latestVo2Max: FitnessBodyMetricDto | null;
  /** Up to 60 VO2 max entries newest-first, for trend display. */
  vo2maxHistory: FitnessBodyMetricDto[];
  /** Up to 60 days with steps, newest-first, for the Steps sparkline. */
  stepsHistory: FitnessStepsDayDto[];
  activeGoal: FitnessGoalDto | null;
};
