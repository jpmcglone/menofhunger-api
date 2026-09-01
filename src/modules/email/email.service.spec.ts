import { EmailService } from './email.service';
import { RedisKeys } from '../redis/redis-keys';

function utcDateKey(): string {
  return new Date().toISOString().slice(0, 10);
}

describe('EmailService broadcast category', () => {
  function makeService(opts?: { engagementBlocked?: boolean; broadcastCount?: string }) {
    const redisStore = new Map<string, string>();
    if (opts?.engagementBlocked) {
      redisStore.set(RedisKeys.emailLastEngagement('u1'), String(Date.now()));
    }
    if (opts?.broadcastCount) {
      redisStore.set(RedisKeys.emailBroadcastDailyCount(utcDateKey()), opts.broadcastCount);
    }

    const redis = {
      getString: jest.fn(async (key: string) => redisStore.get(key) ?? null),
      setString: jest.fn(async (key: string, value: string) => {
        redisStore.set(key, value);
      }),
      raw: () => ({
        incr: jest.fn(async (key: string) => {
          const next = Number(redisStore.get(key) ?? '0') + 1;
          redisStore.set(key, String(next));
          return next;
        }),
        pexpire: jest.fn(async () => 1),
      }),
    };

    const resend = {
      sendEmail: jest.fn(async () => ({ sent: true })),
    };

    const appConfig = {
      emailDailyQuotaLimit: () => 100,
      emailDailyVerificationReserve: () => 15,
      emailBroadcastDailyQuota: () => 5000,
      isProd: () => true,
      email: () => ({ provider: 'resend', apiKey: 'k', fromEmail: { default: 'a@b.c' } }),
    };

    const svc = new EmailService(resend as any, appConfig as any, redis as any);
    return { svc, resend, redisStore };
  }

  it('sends a broadcast even when the per-user engagement cap is active', async () => {
    const { svc, resend } = makeService({ engagementBlocked: true });
    const result = await svc.sendEmail({
      to: 'a@b.c',
      subject: 'Lodge letter',
      text: 'Hi',
      category: 'broadcast',
      userId: 'u1',
    });
    expect(result).toEqual({ sent: true });
    expect(resend.sendEmail).toHaveBeenCalled();
  });

  it('blocks broadcast when the broadcast daily quota is exhausted', async () => {
    const { svc, resend } = makeService({ broadcastCount: '5000' });
    const result = await svc.sendEmail({
      to: 'a@b.c',
      subject: 'Lodge letter',
      text: 'Hi',
      category: 'broadcast',
      userId: 'u1',
    });
    expect(result).toEqual({ sent: false, reason: 'email_quota_broadcast_limit' });
    expect(resend.sendEmail).not.toHaveBeenCalled();
  });
});
