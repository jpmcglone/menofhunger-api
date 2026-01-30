import { Controller, Get } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { AppConfigService } from '../app/app-config.service';

@Controller('health')
export class HealthController {
  constructor(
    private readonly prisma: PrismaService,
    private readonly appConfig: AppConfigService,
  ) {}

  @Get()
  async health() {
    const nowIso = new Date().toISOString();
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
        status: 'ok',
        nowIso,
        uptimeSeconds,
        service: 'menofhunger-api',
        config,
        db: { status: 'ok', latencyMs },
      };
    } catch (err) {
      const latencyMs = Date.now() - startedAt;
      return {
        status: 'degraded',
        nowIso,
        uptimeSeconds,
        service: 'menofhunger-api',
        config,
        db: {
          status: 'down',
          latencyMs,
          error: String((err as Error)?.message ?? err),
        },
      };
    }
  }
}

