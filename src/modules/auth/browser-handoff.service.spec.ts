import { BadRequestException } from '@nestjs/common';
import { AUTH_COOKIE_NAME } from './auth.constants';
import { BrowserHandoffService } from './browser-handoff.service';

function makeService() {
  const values = new Map<string, string>();
  const redis = {
    setJson: jest.fn(async (key: string, value: unknown) => {
      if (values.has(key)) return false;
      values.set(key, JSON.stringify(value));
      return true;
    }),
    raw: jest.fn(() => ({
      eval: jest.fn(async (_script: string, _keyCount: number, key: string) => {
        const value = values.get(key) ?? null;
        values.delete(key);
        return value;
      }),
    })),
  } as any;
  const appConfig = {
    browserHandoffBaseUrl: jest.fn(() => 'https://api.menofhunger.com/v1'),
    frontendBaseUrl: jest.fn(() => 'https://menofhunger.com'),
  } as any;
  const auth = {
    createSessionForUser: jest.fn(async (_userId: string, res: any) => {
      res.cookie(AUTH_COOKIE_NAME, 'new-browser-session', {
        httpOnly: true,
        secure: true,
        sameSite: 'lax',
      });
      return { id: 'new-session' };
    }),
  } as any;
  const service = new BrowserHandoffService(redis, appConfig, auth);
  return { service, redis, auth, values };
}

describe('BrowserHandoffService', () => {
  afterEach(() => {
    jest.useRealTimers();
  });

  it('mints a 90-second handoff URL while storing only the code hash', async () => {
    jest.useFakeTimers().setSystemTime(new Date('2026-07-13T18:00:00.000Z'));
    const { service, redis, values } = makeService();

    const result = await service.mint('user-1', '/settings/billing?from=ios');
    const url = new URL(result.handoffUrl);
    const code = url.searchParams.get('code');

    expect(url.origin).toBe('https://api.menofhunger.com');
    expect(url.pathname).toBe('/v1/auth/browser-handoff/redeem');
    expect(code).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(result.expiresAt).toBe('2026-07-13T18:01:30.000Z');
    expect(redis.setJson).toHaveBeenCalledWith(
      expect.stringMatching(/^auth:browser-handoff:[a-f0-9]{64}$/),
      expect.objectContaining({
        userId: 'user-1',
        destination: '/settings/billing?from=ios',
      }),
      { ttlMs: 90_000, onlyIfAbsent: true },
    );
    expect([...values.keys()].join(' ')).not.toContain(code!);
    expect([...values.values()].join(' ')).not.toContain(code!);
  });

  it.each(['https://evil.example/steal', '//evil.example/steal', '/\\evil.example/steal', '/safe#fragment'])(
    'rejects unsafe destination %s',
    async (destination) => {
      const { service } = makeService();
      await expect(service.mint('user-1', destination)).rejects.toBeInstanceOf(BadRequestException);
    },
  );

  it('atomically consumes once, creates a separate session, sets its cookie, and redirects safely', async () => {
    const { service, auth } = makeService();
    const minted = await service.mint('user-1', '/referrals?source=ios');
    const code = new URL(minted.handoffUrl).searchParams.get('code')!;
    const response = { cookie: jest.fn() } as any;

    await expect(service.redeem(code, response)).resolves.toEqual({
      destinationUrl: 'https://menofhunger.com/referrals?source=ios',
    });
    expect(auth.createSessionForUser).toHaveBeenCalledWith('user-1', response);
    expect(response.cookie).toHaveBeenCalledWith(
      AUTH_COOKIE_NAME,
      'new-browser-session',
      expect.objectContaining({ httpOnly: true }),
    );

    await expect(service.redeem(code, response)).resolves.toBeNull();
    expect(auth.createSessionForUser).toHaveBeenCalledTimes(1);
  });

  it('rejects an expired payload even if Redis has not evicted it yet', async () => {
    jest.useFakeTimers().setSystemTime(new Date('2026-07-13T18:00:00.000Z'));
    const { service, auth } = makeService();
    const minted = await service.mint('user-1', '/');
    const code = new URL(minted.handoffUrl).searchParams.get('code')!;

    jest.setSystemTime(new Date('2026-07-13T18:01:31.000Z'));
    await expect(service.redeem(code, { cookie: jest.fn() } as any)).resolves.toBeNull();
    expect(auth.createSessionForUser).not.toHaveBeenCalled();
  });

  it('returns a non-secret login error redirect for an invalid code', async () => {
    const { service, auth } = makeService();

    await expect(service.redeem('invalid', { cookie: jest.fn() } as any)).resolves.toBeNull();
    expect(service.invalidRedirectUrl()).toBe('https://menofhunger.com/login?handoffError=invalid_or_expired');
    expect(auth.createSessionForUser).not.toHaveBeenCalled();
  });
});
