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

    const preferences = { blockedReason: jest.fn(async (_request: unknown): Promise<string | null> => null), decorate: (request: unknown) => request };
    const delivery = {
      alreadySent: jest.fn(async () => false),
      prepare: jest.fn(async (request: unknown) => ({ id: 'delivery', status: 'pending', requestJson: JSON.stringify(request) })),
      claim: jest.fn(async () => true), providerKey: () => 'stable-key', finish: jest.fn(),
    };
    const budget = {
      reserve: jest.fn(async (category: string) => {
        if (category === 'broadcast' && Number(redisStore.get(RedisKeys.emailBroadcastDailyCount(utcDateKey())) ?? '0') >= 5000) return { allowed: false, reason: 'email_quota_broadcast_limit' };
        return { allowed: true, reservation: {} };
      }),
      reconcile: jest.fn(async () => undefined), broadcastRemaining: jest.fn(async () => 5000),
    };
    const svc = new EmailService(resend as any, appConfig as any, budget as any, delivery as any, preferences as any);
    return { svc, resend, redisStore, delivery, preferences };
  }

  it('gives requested notices priority over a previously sent onboarding tip', async () => {
    const { svc, resend } = makeService({ engagementBlocked: true });
    expect(await svc.sendText({ to: 'a@b.c', subject: 'Your invitation', text: 'Join', category: 'service', userId: 'u1' })).toEqual({ sent: true });
    expect(resend.sendEmail).toHaveBeenCalledWith(expect.objectContaining({ idempotencyKey: 'stable-key' }));
  });

  it('recovers a successful event checkpoint even when daily quota is now exhausted', async () => {
    const { svc, resend, delivery } = makeService({ broadcastCount: '5000' });
    delivery.alreadySent.mockResolvedValue(true);
    expect(await svc.sendText({ to: 'a@b.c', subject: 'Letter', text: 'Hi', category: 'broadcast', eventKey: 'letter:u1' })).toEqual({ sent: true });
    expect(resend.sendEmail).not.toHaveBeenCalled();
  });

  it('fails closed before provider calls when the recipient is suppressed', async () => {
    const { svc, resend, preferences } = makeService();
    preferences.blockedReason.mockResolvedValue('email_suppressed' as never);
    expect(await svc.sendText({ to: 'a@b.c', subject: 'Security', text: 'Hi', category: 'transactional' })).toEqual({ sent: false, reason: 'email_suppressed' });
    expect(resend.sendEmail).not.toHaveBeenCalled();
  });

  it('rechecks the immutable previous attempt before sending to a changed account address', async () => {
    const { svc, resend, preferences, delivery } = makeService();
    delivery.prepare.mockResolvedValue({ id: 'delivery', status: 'pending', requestJson: JSON.stringify({ to: 'old@example.com', subject: 'Private', text: 'Content', userId: 'u1' }) } as never);
    preferences.blockedReason.mockImplementation(async (request: any) => request.to === 'old@example.com' ? 'email_recipient_changed' as never : null);
    expect(await svc.sendText({ to: 'new@example.com', subject: 'Private', text: 'Content', userId: 'u1', eventKey: 'stable' })).toEqual({ sent: false, reason: 'email_recipient_changed' });
    expect(resend.sendEmail).not.toHaveBeenCalled();
    expect(delivery.finish).toHaveBeenCalledWith(expect.anything(), { sent: false, reason: 'email_recipient_changed' }, expect.objectContaining({ to: 'old@example.com' }));
  });

  it('refuses an older private body after caller access revalidation produces a changed message', async () => {
    const { svc, resend, delivery } = makeService();
    delivery.prepare.mockResolvedValue({ id: 'delivery', status: 'pending', retrySafe: false, requestJson: JSON.stringify({ to: 'a@b.c', subject: 'Reply', text: 'Old private content', from: 'a@b.c', category: 'service', userId: 'u1' }) } as never);
    expect(await svc.sendText({ to: 'a@b.c', subject: 'Reply', text: 'New safe content', category: 'service', userId: 'u1', eventKey: 'reply:1' })).toEqual({ sent: false, reason: 'email_content_changed' });
    expect(resend.sendEmail).not.toHaveBeenCalled();
  });

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
    expect(result).toEqual({ sent: false, reason: 'email_quota_broadcast_limit', retryable: true });
    expect(resend.sendEmail).not.toHaveBeenCalled();
  });
});
