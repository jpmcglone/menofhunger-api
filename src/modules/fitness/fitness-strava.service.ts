import { Injectable, Logger, BadRequestException } from '@nestjs/common';
import { AppConfigService } from '../app/app-config.service';
import { PrismaService } from '../prisma/prisma.service';
import type { FitnessActivityType } from '@prisma/client';

const STRAVA_BASE = 'https://www.strava.com';
const STRAVA_API = `${STRAVA_BASE}/api/v3`;
const STRAVA_AUTH = `${STRAVA_BASE}/oauth`;

export type StravaTokens = {
  accessToken: string;
  refreshToken: string;
  expiresAt: number;
  athleteId: number;
};

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
      scope: 'read,activity:read_all',
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
    const params = new URLSearchParams({ per_page: '50' });
    if (after) params.set('after', String(after));

    const res = await fetch(`${STRAVA_API}/athlete/activities?${params.toString()}`, {
      headers: { Authorization: `Bearer ${accessToken}` },
    });

    if (res.status === 401) throw new Error('Strava unauthorized');
    if (!res.ok) throw new Error(`Strava activities fetch failed: ${res.status}`);

    const activities: StravaAthleteActivity[] = await res.json();
    return activities.map((a) => ({
      ...a,
      _mappedType: mapActivityType(a.sport_type ?? a.type),
    })) as any;
  }

  normalizeActivity(a: StravaAthleteActivity & { _mappedType?: FitnessActivityType }) {
    return {
      provider: 'strava' as const,
      externalId: String(a.id),
      activityType: (a as any)._mappedType ?? mapActivityType(a.sport_type ?? a.type),
      startedAt: new Date(a.start_date),
      endedAt: null,
      durationSec: a.elapsed_time,
      distanceM: a.distance > 0 ? a.distance : null,
      effortScore: typeof a.suffer_score === 'number' && a.suffer_score > 0 ? a.suffer_score : null,
      stepsCount: null,
      calories: typeof a.calories === 'number' && a.calories > 0 ? a.calories : null,
      avgHeartrate: typeof a.average_heartrate === 'number' && a.average_heartrate > 0 ? a.average_heartrate : null,
      maxHeartrate: typeof a.max_heartrate === 'number' && a.max_heartrate > 0 ? a.max_heartrate : null,
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
}
