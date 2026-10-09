import { EmailBudgetService, RESERVE_EMAIL_BUDGET, RECONCILE_EMAIL_BUDGET } from './email-budget.service';

function setup(result: number | Error = 1) {
  const redis = { raw: () => ({ eval: jest.fn() }), getString: jest.fn() };
  const evalFn = jest.fn(async () => { if (result instanceof Error) throw result; return result; });
  redis.raw = () => ({ eval: evalFn });
  const config = { emailDailyQuotaLimit: () => 100, emailDailyVerificationReserve: () => 15, emailBroadcastDailyQuota: () => 5000 };
  return { service: new EmailBudgetService(config as never, redis as never), evalFn, redis };
}

describe('atomic email budget adapter', () => {
  it('preserves the account reserve while requested notices bypass the optional user cap', async () => {
    const { service, evalFn } = setup();
    expect((await service.reserve('service', 'user', 'delivery')).allowed).toBe(true);
    expect(evalFn).toHaveBeenLastCalledWith(RESERVE_EMAIL_BUDGET, 3, expect.stringContaining('email:'), expect.any(String), expect.any(String), 85, '0', 'delivery', 172800000, 93600000);
    await service.reserve('transactional', 'user', 'account');
    expect(evalFn).toHaveBeenLastCalledWith(RESERVE_EMAIL_BUDGET, 3, expect.any(String), expect.any(String), expect.any(String), 100, '0', 'account', 172800000, 93600000);
  });

  it.each([['transactional', 'email_quota_hard_limit'], ['service', 'email_quota_engagement_limit'], ['engagement', 'email_quota_engagement_limit'], ['broadcast', 'email_quota_broadcast_limit']] as const)('returns the specific quota reason for %s', async (category, reason) => {
    expect(await setup(2).service.reserve(category, 'user', 'delivery')).toEqual({ allowed: false, reason });
  });

  it('fails closed on Redis failure and unknown script output', async () => {
    expect(await setup(new Error('offline')).service.reserve('transactional', 'user', 'delivery')).toEqual({ allowed: false, reason: 'email_quota_unavailable' });
    expect(await setup(0).service.reserve('transactional', 'user', 'delivery')).toEqual({ allowed: false, reason: 'email_quota_unavailable' });
  });

  it('retains uncertain sends and only releases a definitive provider rejection', async () => {
    const { service, evalFn } = setup();
    const reservation = await service.reserve('engagement', 'user', 'delivery');
    await service.reconcile(reservation, { sent: false, reason: 'email_failed', retryable: true });
    expect(evalFn).toHaveBeenLastCalledWith(RECONCILE_EMAIL_BUDGET, 3, expect.any(String), expect.any(String), expect.any(String), 'uncertain', '1', 'delivery');
    await service.reconcile(reservation, { sent: false, reason: 'resend_failed', retryable: true, definitiveRejection: true });
    expect(evalFn).toHaveBeenLastCalledWith(RECONCILE_EMAIL_BUDGET, 3, expect.any(String), expect.any(String), expect.any(String), 'rejected', '1', 'delivery');
  });
});
