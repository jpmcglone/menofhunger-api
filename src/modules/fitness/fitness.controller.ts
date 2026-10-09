import { Body, Controller, Delete, Get, HttpCode, HttpStatus, Param, Post, Put, Query, UseGuards } from '@nestjs/common';
import { z } from 'zod';
import { ApiTags } from '@nestjs/swagger';
import { AuthGuard } from '../auth/auth-public-api';
import { IdentityVerifiedGuard } from '../auth/auth-public-api';
import { FitnessStravaGuard } from './fitness-strava.guard';
import { CurrentUserId } from '../users/users.decorator';
import { PersonAccountGuard } from '../pages/person-account.guard';
import { AppConfigService } from '../app/app-config.service';
import { FitnessService } from './fitness.service';
import {
  connectStravaSchema,
  manualSyncSchema,
  uploadHealthKitSchema,
  logWeightSchema,
  upsertGoalSchema,
  updateUnitsSchema,
  createSharePostSchema,
} from './fitness.schemas';

@ApiTags('Fitness')
@Controller('fitness')
@UseGuards(AuthGuard, IdentityVerifiedGuard, PersonAccountGuard)
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
      shareType: payload.shareType,
      body: payload.body,
      visibility: payload.visibility,
      activityId: payload.activityId,
      bodyMetricId: payload.bodyMetricId,
      goalId: payload.goalId,
      r2BaseUrl,
    });
    return { data: result };
  }
}
