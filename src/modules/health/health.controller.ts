import { Controller, Get, Res } from '@nestjs/common';
import type { Response } from 'express';
import { PrismaService } from '../prisma/prisma.service';
import { AppConfigService } from '../app/app-config.service';
import { RedisService } from '../redis/redis.service';
import { setReadCache } from '../../common/http-cache';

@Controller('health')
export class HealthController {
  constructor(
    private readonly prisma: PrismaService,
    private readonly appConfig: AppConfigService,
    private readonly redis: RedisService,
  ) {}

  @Get()
  async health(@Res({ passthrough: true }) httpRes: Response) {
    // No caching — health checks must reflect real-time state.
    setReadCache(httpRes, { viewerUserId: null, publicMaxAgeSeconds: 0, publicStaleWhileRevalidateSeconds: 0, varyCookie: false });
    const now = new Date();
    const nowIso = now.toISOString();
    const serverTime = Math.floor(now.getTime() / 1000);
    const uptimeSeconds = Math.max(0, Math.floor(process.uptime()));

    const config = {
      nodeEnv: this.appConfig.nodeEnv(),
      r2Configured: Boolean(this.appConfig.r2()),
      giphyConfigured: Boolean(this.appConfig.giphyApiKey()),
      twilioConfigured: Boolean(this.appConfig.twilioVerify()),
      // Only relevant in non-production environments (Twilio is never disabled in prod).
      ...(this.appConfig.nodeEnv() !== 'production' ? { twilioDisabledInDev: this.appConfig.disableTwilioInDev() } : {}),
      /** Location search / geocode (Mapbox). Unset = profile location lookup will 400. */
      locationSearchConfigured: Boolean(this.appConfig.mapbox()),
      stripeConfigured: Boolean(this.appConfig.stripe()),
      emailConfigured: Boolean(this.appConfig.email()),
      /** Browser (Web Push) via VAPID. Other push channels (e.g. mobile) are separate. */
      browserPushConfigured: this.appConfig.vapidConfigured(),
    };

    const [dbResult, redisResult] = await Promise.all([
      this.checkDb(),
      this.checkRedis(),
    ]);

    const allOk = dbResult.status === 'ok' && redisResult.status === 'ok';
    const overallStatus = allOk ? 'ok' : 'degraded';

    if (!allOk) {
      httpRes.status(503);
    }

    return {
      data: {
        status: overallStatus,
        nowIso,
        serverTime,
        uptimeSeconds,
        service: 'menofhunger-api',
        config,
        db: dbResult,
        redis: redisResult,
      },
    };
  }

  private async checkDb(): Promise<{ status: 'ok' | 'down'; latencyMs: number; error?: string }> {
    const startedAt = Date.now();
    try {
      await this.prisma.$queryRaw`SELECT 1`;
      return { status: 'ok', latencyMs: Date.now() - startedAt };
    } catch (err) {
      return {
        status: 'down',
        latencyMs: Date.now() - startedAt,
        error: String((err as Error)?.message ?? err),
      };
    }
  }

  private async checkRedis(): Promise<{ status: 'ok' | 'down'; latencyMs: number; error?: string }> {
    const startedAt = Date.now();
    try {
      await this.redis.raw().ping();
      return { status: 'ok', latencyMs: Date.now() - startedAt };
    } catch (err) {
      return {
        status: 'down',
        latencyMs: Date.now() - startedAt,
        error: String((err as Error)?.message ?? err),
      };
    }
  }
}

