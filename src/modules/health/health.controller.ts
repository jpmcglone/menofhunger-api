import { Controller, Get, Res } from '@nestjs/common';
import type { Response } from 'express';
import { PrismaService } from '../prisma/prisma.service';
import { AppConfigService } from '../app/app-config.service';
import { setReadCache } from '../../common/http-cache';

@Controller('health')
export class HealthController {
  constructor(
    private readonly prisma: PrismaService,
    private readonly appConfig: AppConfigService,
  ) {}

  @Get()
  async health(@Res({ passthrough: true }) httpRes: Response) {
    setReadCache(httpRes, { viewerUserId: null, publicMaxAgeSeconds: 30, publicStaleWhileRevalidateSeconds: 0, varyCookie: false });
    const now = new Date();
    const nowIso = now.toISOString();
    const serverTime = Math.floor(now.getTime() / 1000);
    const uptimeSeconds = Math.max(0, Math.floor(process.uptime()));

    const config = {
      nodeEnv: this.appConfig.nodeEnv(),
      r2Configured: Boolean(this.appConfig.r2()),
      giphyConfigured: Boolean(this.appConfig.giphyApiKey()),
      // Twilio can be intentionally disabled in dev; show both flags so it's obvious.
      twilioConfigured: Boolean(this.appConfig.twilioVerify()),
      twilioDisabledInDev: this.appConfig.disableTwilioInDev(),
    };

    const startedAt = Date.now();
    try {
      // Readiness-style check: ensure the DB can execute a trivial query.
      await this.prisma.$queryRaw`SELECT 1`;
      const latencyMs = Date.now() - startedAt;
      return {
        data: {
          status: 'ok',
          nowIso,
          serverTime,
          uptimeSeconds,
          service: 'menofhunger-api',
          config,
          db: { status: 'ok', latencyMs },
        },
      };
    } catch (err) {
      const latencyMs = Date.now() - startedAt;
      return {
        data: {
          status: 'degraded',
          nowIso,
          serverTime,
          uptimeSeconds,
          service: 'menofhunger-api',
          config,
          db: {
            status: 'down',
            latencyMs,
            error: String((err as Error)?.message ?? err),
          },
        },
      };
    }
  }
}

