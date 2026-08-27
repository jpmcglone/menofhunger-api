import { Body, Controller, Delete, Get, HttpCode, HttpStatus, Param, Post, Put, Query, UseGuards } from '@nestjs/common';
import { z } from 'zod';
import { ApiTags } from '@nestjs/swagger';
import { AuthGuard } from '../auth/auth.guard';
import { VerifiedGuard } from '../auth/verified.guard';
import { FitnessStravaGuard } from './fitness-strava.guard';
import { CurrentUserId } from '../users/users.decorator';
import { PersonAccountGuard } from '../pages/person-account.guard';
import { AppConfigService } from '../app/app-config.service';
import { FitnessService } from './fitness.service';

// ─── Zod schemas ──────────────────────────────────────────────────────────────

const connectStravaSchema = z.object({
  code: z.string().trim().min(1),
  redirectUri: z.string().url(),
});

const manualSyncSchema = z.object({
  provider: z.enum(['strava']),
});

const healthKitActivitySchema = z.object({
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
  raw: z.unknown().optional(),
});

const healthKitBodyMetricSchema = z.object({
  externalId: z.string(),
  weightKg: z.number().positive(),
  measuredAt: z.string().datetime(),
});

const healthKitSleepSchema = z.object({
  dayKey: z.string(),
  sleepMinutes: z.number().int().nonnegative(),
});

const healthKitHrvSchema = z.object({
  dayKey: z.string(),
  hrvMs: z.number().nonnegative(),
});

const healthKitVo2MaxSchema = z.object({
  externalId: z.string(),
  vo2maxMlKgMin: z.number().positive(),
  measuredAt: z.string().datetime(),
});

const healthKitDailyStepsSchema = z.object({
  dayKey: z.string(),
  stepsCount: z.number().int().nonnegative(),
});

const uploadHealthKitSchema = z.object({
  activities: z.array(healthKitActivitySchema).optional(),
  bodyMetrics: z.array(healthKitBodyMetricSchema).optional(),
  vo2maxReadings: z.array(healthKitVo2MaxSchema).optional(),
  sleepMinutes: z.array(healthKitSleepSchema).optional(),
  hrv: z.array(healthKitHrvSchema).optional(),
  dailySteps: z.array(healthKitDailyStepsSchema).optional(),
});

const logWeightSchema = z.object({
  weightKg: z.number().positive(),
  measuredAt: z.string().datetime().optional(),
});

const upsertGoalSchema = z.object({
  kind: z.literal('weight'),
  startKg: z.number().positive().optional(),
  targetKg: z.number().positive(),
});

const updateUnitsSchema = z.object({
  units: z.enum(['us', 'metric']),
});

const createSharePostSchema = z.object({
  shareType: z.enum(['activity', 'weight', 'progress', 'vo2max']),
  body: z.string().trim().max(500).default(''),
  visibility: z.enum(['public', 'verifiedOnly', 'premiumOnly', 'onlyMe']).default('verifiedOnly'),
  activityId: z.string().optional(),
  bodyMetricId: z.string().optional(),
  goalId: z.string().optional(),
});

@ApiTags('Fitness')
@Controller('fitness')
@UseGuards(AuthGuard, VerifiedGuard, PersonAccountGuard)
export class FitnessController {
  constructor(
    private readonly fitness: FitnessService,
    private readonly appConfig: AppConfigService,
  ) {}

  // ─── Overview page ─────────────────────────────────────────────────────────

  @Get('me')
  async getPage(@CurrentUserId() userId: string) {
    const page = await this.fitness.getPage(userId);
    return { data: page };
  }

  @Get('activities/:id')
  async getActivity(
    @CurrentUserId() userId: string,
    @Param('id') id: string,
  ) {
    const activity = await this.fitness.getActivity(userId, id);
    return { data: activity };
  }

  // ─── Strava OAuth ───────────────────────────────────────────────────────────

  @Get('strava/auth-url')
  @UseGuards(FitnessStravaGuard)
  async getStravaAuthUrl(
    @CurrentUserId() userId: string,
    @Query() query: unknown,
  ) {
    const { redirectUri } = z.object({ redirectUri: z.string().url() }).parse(query);
    const url = this.fitness.getStravaAuthUrl(userId, redirectUri);
    return { data: { url } };
  }

  @Post('strava/connect')
  @UseGuards(FitnessStravaGuard)
  async connectStrava(
    @CurrentUserId() userId: string,
    @Body() body: unknown,
  ) {
    const { code, redirectUri } = connectStravaSchema.parse(body);
    const _ = redirectUri; // stored for completeness; already exchanged on server
    const connection = await this.fitness.connectStrava(userId, code);
    return { data: { connection } };
  }

  @Delete('strava/disconnect')
  async disconnectStrava(@CurrentUserId() userId: string) {
    await this.fitness.disconnectStrava(userId);
    return { data: null };
  }

  @Delete('apple_health/disconnect')
  async disconnectAppleHealth(@CurrentUserId() userId: string) {
    await this.fitness.disconnectAppleHealth(userId);
    return { data: null };
  }

  // ─── Manual sync ───────────────────────────────────────────────────────────

  @Post('sync')
  @UseGuards(FitnessStravaGuard)
  async syncNow(
    @CurrentUserId() userId: string,
    @Body() body: unknown,
  ) {
    const { provider } = manualSyncSchema.parse(body);
    if (provider === 'strava') {
      const result = await this.fitness.syncStrava(userId, true);
      return { data: result };
    }
    return { data: { inserted: 0, deduped: 0 } };
  }

  // ─── HealthKit upload ──────────────────────────────────────────────────────

  @Post('healthkit/upload')
  async uploadHealthKit(
    @CurrentUserId() userId: string,
    @Body() body: unknown,
  ) {
    const payload = uploadHealthKitSchema.parse(body);
    const result = await this.fitness.uploadHealthKit(userId, payload);
    return { data: result };
  }

  // ─── Weight log ────────────────────────────────────────────────────────────

  @Post('weight')
  async logWeight(
    @CurrentUserId() userId: string,
    @Body() body: unknown,
  ) {
    const { weightKg, measuredAt } = logWeightSchema.parse(body);
    const metric = await this.fitness.logWeight(userId, weightKg, measuredAt ? new Date(measuredAt) : undefined);
    return { data: metric };
  }

  @Get('weight/history')
  async getWeightHistory(@CurrentUserId() userId: string) {
    const history = await this.fitness.getWeightHistory(userId);
    return { data: history };
  }

  // ─── Goals ─────────────────────────────────────────────────────────────────

  @Get('goals')
  async getGoals(@CurrentUserId() userId: string) {
    const goals = await this.fitness.getGoals(userId);
    return { data: goals };
  }

  @Put('goals')
  async upsertGoal(
    @CurrentUserId() userId: string,
    @Body() body: unknown,
  ) {
    const { startKg, targetKg } = upsertGoalSchema.parse(body);
    const goal = await this.fitness.upsertWeightGoal(userId, { startKg, targetKg });
    return { data: goal };
  }

  // ─── Units ─────────────────────────────────────────────────────────────────

  @Put('units')
  @HttpCode(HttpStatus.NO_CONTENT)
  async updateUnits(
    @CurrentUserId() userId: string,
    @Body() body: unknown,
  ) {
    const { units } = updateUnitsSchema.parse(body);
    await this.fitness.updateUnits(userId, units);
  }

  // ─── Share posts ───────────────────────────────────────────────────────────

  @Post('share')
  async createShare(
    @CurrentUserId() userId: string,
    @Body() body: unknown,
  ) {
    const payload = createSharePostSchema.parse(body);
    const r2BaseUrl = this.appConfig.r2()?.publicBaseUrl ?? null;
    const result = await this.fitness.createSharePost({
      userId,
      shareType: payload.shareType as any,
      body: payload.body,
      visibility: payload.visibility as any,
      activityId: payload.activityId,
      bodyMetricId: payload.bodyMetricId,
      goalId: payload.goalId,
      r2BaseUrl,
    });
    return { data: result };
  }
}
