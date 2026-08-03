/**
 * The auto-verify site toggle is evaluated here, in the worker, rather than at the signup /
 * referral call site — so an admin flipping the toggle takes effect for jobs already queued.
 */
import { VerificationSideEffectsHandler } from './verification-side-effects.handler';

function build(opts: { autoVerify: boolean; autoVerifyRecruiterId: string | null }) {
  const userVerification = {
    verifyUser: jest.fn(async () => ({
      verified: true,
      alreadyVerified: false,
      userId: 'u1',
      previousUnverifiedAt: null,
    })),
  };
  const siteConfig = {
    getUncached: jest.fn(async () => ({
      autoVerifyNewUsers: opts.autoVerify,
      autoVerifyRecruiterId: opts.autoVerifyRecruiterId,
    })),
    shouldAutoVerify: jest.fn((cfg: any, recruitedById: string | null) => {
      if (!cfg.autoVerifyNewUsers) return false;
      if (cfg.autoVerifyRecruiterId == null) return true;
      return Boolean(recruitedById && cfg.autoVerifyRecruiterId === recruitedById);
    }),
  };
  const notifications = { create: jest.fn(async () => undefined) };
  const registry = { register: jest.fn() };

  const handler = new VerificationSideEffectsHandler(
    userVerification as any,
    siteConfig as any,
    notifications as any,
    registry as any,
  );
  return { handler, userVerification, siteConfig, notifications, registry };
}

describe('user.auto-verify', () => {
  it('verifies when the toggle matches the recruiter', async () => {
    const { handler, userVerification } = build({ autoVerify: true, autoVerifyRecruiterId: 'recruiter-1' });

    await handler['onAutoVerify']({ userId: 'u1', recruitedById: 'recruiter-1', source: 'auto_referral' });

    expect(userVerification.verifyUser).toHaveBeenCalledWith({ userId: 'u1', source: 'auto_referral' });
  });

  it('verifies every signup when no recruiter filter is set', async () => {
    const { handler, userVerification } = build({ autoVerify: true, autoVerifyRecruiterId: null });

    await handler['onAutoVerify']({ userId: 'u1', recruitedById: null, source: 'auto_signup' });

    expect(userVerification.verifyUser).toHaveBeenCalledWith({ userId: 'u1', source: 'auto_signup' });
  });

  it('does nothing when the toggle is off', async () => {
    const { handler, userVerification } = build({ autoVerify: false, autoVerifyRecruiterId: 'recruiter-1' });

    await handler['onAutoVerify']({ userId: 'u1', recruitedById: 'recruiter-1', source: 'auto_referral' });

    expect(userVerification.verifyUser).not.toHaveBeenCalled();
  });

  it('does nothing when the recruiter filter does not match', async () => {
    const { handler, userVerification } = build({ autoVerify: true, autoVerifyRecruiterId: 'other-recruiter' });

    await handler['onAutoVerify']({ userId: 'u1', recruitedById: 'recruiter-1', source: 'auto_referral' });

    expect(userVerification.verifyUser).not.toHaveBeenCalled();
  });

  /** The toggle must be read fresh, not from the 5-minute cache the rate limiter uses. */
  it('reads the toggle uncached', async () => {
    const { handler, siteConfig } = build({ autoVerify: true, autoVerifyRecruiterId: null });

    await handler['onAutoVerify']({ userId: 'u1', recruitedById: null, source: 'auto_signup' });

    expect(siteConfig.getUncached).toHaveBeenCalled();
  });
});

describe('user.verified', () => {
  it('writes the account_verified notification', async () => {
    const { handler, notifications } = build({ autoVerify: false, autoVerifyRecruiterId: null });

    await handler['onVerified']({ userId: 'u1' });

    expect(notifications.create).toHaveBeenCalledWith(
      expect.objectContaining({ recipientUserId: 'u1', kind: 'account_verified', subjectUserId: 'u1' }),
    );
  });
});
