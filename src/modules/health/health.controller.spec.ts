import { HealthController } from './health.controller';
import type { AppConfigService } from '../app/app-config.service';
import type { PrismaService } from '../prisma/prisma.service';
import type { RedisService } from '../redis/redis.service';

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
