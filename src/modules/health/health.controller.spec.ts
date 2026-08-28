import { HealthController } from './health.controller';
import type { AppConfigService } from '../app/app-config.service';
import type { PrismaService } from '../prisma/prisma.service';
import type { RedisService } from '../redis/redis.service';

describe('HealthController.health', () => {
  function makeHealthController(opts?: { dbOk?: boolean; redisOk?: boolean }) {
    const httpRes = { status: jest.fn(), setHeader: jest.fn() };
    const prisma = {
      $queryRaw: jest.fn(async () => {
        if (opts?.dbOk === false) throw new Error('db down');
        return 1;
      }),
    } as unknown as PrismaService;
    const redis = {
      raw: () => ({
        ping: jest.fn(async () => {
          if (opts?.redisOk === false) throw new Error('redis down');
          return 'PONG';
        }),
      }),
    } as unknown as RedisService;
    const appConfig = {} as AppConfigService;
    return {
      controller: new HealthController(prisma, appConfig, redis),
      httpRes: httpRes as unknown as { status: jest.Mock },
    };
  }

  it('returns 2xx when Postgres and Redis are up (Render may flip traffic)', async () => {
    const { controller, httpRes } = makeHealthController();
    const result = await controller.health(httpRes as never);
    expect(result.data.status).toBe('ok');
    expect(httpRes.status).not.toHaveBeenCalled();
  });

  it('returns 503 when Redis is down so Render keeps the previous instance', async () => {
    const { controller, httpRes } = makeHealthController({ redisOk: false });
    const result = await controller.health(httpRes as never);
    expect(result.data.status).toBe('degraded');
    expect(httpRes.status).toHaveBeenCalledWith(503);
  });
});

describe('HealthController.healthConfig', () => {
  function makeController(overrides?: Partial<Record<keyof AppConfigService, unknown>>) {
    const appConfig = {
      nodeEnv: () => 'production',
      r2: () => null,
      giphyApiKey: () => null,
      twilioVerify: () => null,
      disableTwilioInDev: () => false,
      stripe: () => null,
      email: () => null,
      vapidConfigured: () => false,
      allowedOrigins: () => ['https://menofhunger.com'],
      cookieDomain: () => undefined,
      trustProxy: () => true,
      ...overrides,
    } as unknown as AppConfigService;

    const prisma = {} as PrismaService;
    const redis = {} as RedisService;

    return new HealthController(prisma, appConfig, redis);
  }

  it('surfaces allowedOrigins, cookieDomain, and trustProxy for self-service prod auth debugging', async () => {
    const controller = makeController();

    const result = await controller.healthConfig();

    expect(result.data.allowedOrigins).toEqual(['https://menofhunger.com']);
    expect(result.data.cookieDomain).toBeNull();
    expect(result.data.trustProxy).toBe(true);
  });

  it('reports an empty allowedOrigins list as [] (not swallowed) so a misconfigured prod env is obvious', async () => {
    const controller = makeController({ allowedOrigins: () => [] });

    const result = await controller.healthConfig();

    expect(result.data.allowedOrigins).toEqual([]);
  });

  it('reports a configured cookieDomain when set', async () => {
    const controller = makeController({ cookieDomain: () => '.menofhunger.com' });

    const result = await controller.healthConfig();

    expect(result.data.cookieDomain).toBe('.menofhunger.com');
  });
});
