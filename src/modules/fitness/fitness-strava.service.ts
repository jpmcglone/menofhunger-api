import { Injectable, Logger, BadRequestException } from '@nestjs/common';
import { AppConfigService } from '../app/app-config.service';
import { PrismaService } from '../prisma/prisma.service';
import type { FitnessActivityType } from '@prisma/client';
import type { NormalizedActivity } from './fitness-ingest.service';

const STRAVA_BASE = 'https://www.strava.com';
const STRAVA_API = `${STRAVA_BASE}/api/v3`;
const STRAVA_AUTH = `${STRAVA_BASE}/oauth`;

const STRAVA_STREAM_KEYS = [
  'time',
  'latlng',
  'distance',
  'altitude',
  'velocity_smooth',
  'heartrate',
  'cadence',
  'watts',
  'temp',
  'moving',
  'grade_smooth',
].join(',');

export type StravaTokens = {
  accessToken: string;
  refreshToken: string;
  expiresAt: number;
  athleteId: number;
};

export type StravaRateLimitError = Error & { status: 429 };

type StravaAthleteActivity = {
  id: number;
  type: string;
  sport_type: string;
  start_date: string;
  elapsed_time: number;
  distance: number;
  total_elevation_gain: number;
  weighted_average_watts?: number;
  suffer_score?: number | null;
  average_speed: number;
  name: string;
  calories?: number | null;
  average_heartrate?: number | null;
  max_heartrate?: number | null;
  [key: string]: unknown;
};

const ACTIVITY_TYPE_MAP: Record<string, FitnessActivityType> = {
  Run: 'run',
  TrailRun: 'run',
  VirtualRun: 'run',
  Ride: 'ride',
  VirtualRide: 'ride',
  EBikeRide: 'ride',
  Velomobile: 'ride',
  Walk: 'walk',
  Hike: 'hike',
  Swim: 'swim',
  Yoga: 'yoga',
  Workout: 'workout',
  WeightTraining: 'workout',
  CrossFit: 'workout',
  Crossfit: 'workout',
  Rowing: 'workout',
  StandUpPaddling: 'workout',
  Surfing: 'workout',
  Soccer: 'workout',
  Tennis: 'workout',
  Basketball: 'workout',
};

function mapActivityType(type: string): FitnessActivityType {
  return ACTIVITY_TYPE_MAP[type] ?? 'other';
}

function readPositiveInt(value: unknown): number | null {
  if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) return null;
  return Math.floor(value);
}

/** Strava puts steps on walk/run details as `steps`; list payloads often omit it. */
function readStepsCount(
  detail: StravaAthleteActivity,
  list: StravaAthleteActivity,
  raw?: { activity?: Record<string, unknown> },
): number | null {
  return (
    readPositiveInt(detail.steps) ??
    readPositiveInt(list.steps) ??
    readPositiveInt(raw?.activity?.steps)
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

export function stravaRawIsComplete(raw: unknown): boolean {
  if (!isRecord(raw)) return false;
  return isRecord(raw.activity) && raw.streams != null;
}

@Injectable()
export class FitnessStravaService {
  private readonly logger = new Logger(FitnessStravaService.name);

  constructor(
    private readonly appConfig: AppConfigService,
    private readonly prisma: PrismaService,
  ) {}

  getAuthorizationUrl(userId: string, redirectUri: string): string {
    const cfg = this.appConfig.strava();
    if (!cfg) throw new BadRequestException('Strava integration is not configured.');

    const params = new URLSearchParams({
      client_id: cfg.clientId,
      redirect_uri: redirectUri,
      response_type: 'code',
      approval_prompt: 'auto',
      scope: 'read,activity:read_all,profile:read_all',
      state: userId,
    });
    return `${STRAVA_AUTH}/authorize?${params.toString()}`;
  }

  async exchangeCode(code: string): Promise<StravaTokens> {
    const cfg = this.appConfig.strava();
    if (!cfg) throw new BadRequestException('Strava integration is not configured.');

    const res = await fetch(`${STRAVA_AUTH}/token`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        client_id: cfg.clientId,
        client_secret: cfg.clientSecret,
        code,
        grant_type: 'authorization_code',
      }),
    });

    if (!res.ok) {
      const body = await res.text().catch(() => '');
      this.logger.error(`Strava token exchange failed: ${res.status} ${body}`);
      throw new BadRequestException('Failed to connect Strava. Please try again.');
    }

    const data: any = await res.json();
    return {
      accessToken: data.access_token,
      refreshToken: data.refresh_token,
      expiresAt: data.expires_at,
      athleteId: data.athlete?.id,
    };
  }

  async refreshTokenIfNeeded(userId: string): Promise<string | null> {
    const conn = await this.prisma.fitnessConnection.findUnique({
      where: { userId_provider: { userId, provider: 'strava' } },
    });
    if (!conn || conn.status !== 'active' || !conn.accessToken || !conn.refreshToken) return null;

    const nowSec = Math.floor(Date.now() / 1000);
    const expiresAtSec = conn.tokenExpiresAt ? Math.floor(conn.tokenExpiresAt.getTime() / 1000) : 0;

    if (expiresAtSec - nowSec > 300) {
      return conn.accessToken;
    }

    const cfg = this.appConfig.strava();
    if (!cfg) return null;

    try {
      const res = await fetch(`${STRAVA_AUTH}/token`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          client_id: cfg.clientId,
          client_secret: cfg.clientSecret,
          refresh_token: conn.refreshToken,
          grant_type: 'refresh_token',
        }),
      });

      if (!res.ok) {
        await this.prisma.fitnessConnection.update({
          where: { id: conn.id },
          data: { status: 'error', lastError: `Token refresh failed: ${res.status}` },
        });
        return null;
      }

      const data: any = await res.json();
      await this.prisma.fitnessConnection.update({
        where: { id: conn.id },
        data: {
          accessToken: data.access_token,
          refreshToken: data.refresh_token,
          tokenExpiresAt: new Date(data.expires_at * 1000),
          status: 'active',
          lastError: null,
        },
      });
      return data.access_token;
    } catch (err) {
      this.logger.error(`Strava token refresh error for user ${userId}: ${err}`);
      return null;
    }
  }

  async fetchActivities(accessToken: string, after?: number): Promise<StravaAthleteActivity[]> {
    const out: StravaAthleteActivity[] = [];
    for (let page = 1; page <= 50; page += 1) {
      const params = new URLSearchParams({ per_page: '200', page: String(page) });
      if (after) params.set('after', String(after));

      const res = await fetch(`${STRAVA_API}/athlete/activities?${params.toString()}`, {
        headers: { Authorization: `Bearer ${accessToken}` },
      });

      if (res.status === 401) throw new Error('Strava unauthorized');
      if (res.status === 429) throw this.rateLimitError();
      if (!res.ok) throw new Error(`Strava activities fetch failed: ${res.status}`);

      const batch: StravaAthleteActivity[] = await res.json();
      if (!Array.isArray(batch) || batch.length === 0) break;
      out.push(...batch);
      if (batch.length < 200) break;
    }
    return out;
  }

  async fetchActivityDetail(accessToken: string, activityId: number): Promise<Record<string, unknown>> {
    const res = await fetch(`${STRAVA_API}/activities/${activityId}?include_all_efforts=true`, {
      headers: { Authorization: `Bearer ${accessToken}` },
    });
    if (res.status === 429) throw this.rateLimitError();
    if (!res.ok) throw new Error(`Strava activity ${activityId} failed: ${res.status}`);
    return (await res.json()) as Record<string, unknown>;
  }

  async fetchActivityStreams(accessToken: string, activityId: number): Promise<unknown> {
    const params = new URLSearchParams({
      keys: STRAVA_STREAM_KEYS,
      key_by_type: 'true',
    });
    const res = await fetch(`${STRAVA_API}/activities/${activityId}/streams?${params.toString()}`, {
      headers: { Authorization: `Bearer ${accessToken}` },
    });
    if (res.status === 429) throw this.rateLimitError();
    if (res.status === 404) return null;
    if (!res.ok) throw new Error(`Strava streams ${activityId} failed: ${res.status}`);
    return res.json();
  }

  async fetchProfileBundle(accessToken: string, athleteId: number): Promise<Record<string, unknown>> {
    const headers = { Authorization: `Bearer ${accessToken}` };
    const [athleteRes, statsRes, zonesRes] = await Promise.all([
      fetch(`${STRAVA_API}/athlete`, { headers }),
      fetch(`${STRAVA_API}/athletes/${athleteId}/stats`, { headers }),
      fetch(`${STRAVA_API}/athlete/zones`, { headers }),
    ]);
    const athlete = athleteRes.ok ? await athleteRes.json() : null;
    const stats = statsRes.ok ? await statsRes.json() : null;
    const zones = zonesRes.ok ? await zonesRes.json() : null;
    return { athlete, stats, zones, fetchedAt: new Date().toISOString() };
  }

  async enrichActivityRaw(
    accessToken: string,
    listActivity: StravaAthleteActivity,
    existingRaw: unknown,
  ): Promise<{ activity: Record<string, unknown>; streams: unknown }> {
    if (stravaRawIsComplete(existingRaw) && isRecord(existingRaw)) {
      return {
        activity: existingRaw.activity as Record<string, unknown>,
        streams: existingRaw.streams,
      };
    }
    const activity = await this.fetchActivityDetail(accessToken, listActivity.id);
    const streams = await this.fetchActivityStreams(accessToken, listActivity.id);
    return { activity, streams };
  }

  normalizeActivity(
    a: StravaAthleteActivity,
    raw?: { activity?: Record<string, unknown>; streams?: unknown },
  ): NormalizedActivity {
    const detail = (raw?.activity ?? a) as StravaAthleteActivity;
    const type = String(detail.sport_type ?? detail.type ?? a.sport_type ?? a.type ?? '');
    const name = typeof detail.name === 'string' && detail.name.trim() ? detail.name.trim() : null;
    return {
      provider: 'strava',
      externalId: String(a.id),
      activityType: mapActivityType(type),
      startedAt: new Date(String(detail.start_date ?? a.start_date)),
      endedAt: null,
      durationSec: Number(detail.elapsed_time ?? a.elapsed_time) || 0,
      distanceM: Number(detail.distance ?? a.distance) > 0 ? Number(detail.distance ?? a.distance) : null,
      effortScore:
        typeof detail.suffer_score === 'number' && detail.suffer_score > 0 ? detail.suffer_score : null,
      stepsCount: readStepsCount(detail, a, raw),
      calories: typeof detail.calories === 'number' && detail.calories > 0 ? detail.calories : null,
      avgHeartrate:
        typeof detail.average_heartrate === 'number' && detail.average_heartrate > 0
          ? detail.average_heartrate
          : null,
      maxHeartrate:
        typeof detail.max_heartrate === 'number' && detail.max_heartrate > 0 ? detail.max_heartrate : null,
      totalElevationM:
        typeof detail.total_elevation_gain === 'number' && detail.total_elevation_gain > 0
          ? detail.total_elevation_gain
          : null,
      name,
      rawJson: {
        activity: raw?.activity ?? a,
        streams: raw?.streams ?? null,
      },
    };
  }

  async deauthorize(userId: string): Promise<void> {
    const conn = await this.prisma.fitnessConnection.findUnique({
      where: { userId_provider: { userId, provider: 'strava' } },
    });
    if (!conn?.accessToken) return;

    try {
      await fetch(`${STRAVA_AUTH}/deauthorize`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${conn.accessToken}` },
      });
    } catch {
      // Best-effort — token may already be invalid.
    }
  }

  private rateLimitError(): StravaRateLimitError {
    const err = new Error('Strava rate limited') as StravaRateLimitError;
    err.status = 429;
    return err;
  }
}
