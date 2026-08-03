/**
 * `setRecruiter` hands auto-verify to the side-effects queue rather than running it inline —
 * verification gifts coins, records affiliate earnings, and calls Stripe billing hooks, none
 * of which should sit in the latency budget of entering a referral code.
 *
 * The toggle logic itself is covered in
 * `src/modules/verification/verification-side-effects.handler.spec.ts`.
 */
import { ReferralService } from './referral.service';

describe('ReferralService.setRecruiter auto-verify', () => {
  function makeService() {
    const prisma: any = {
      user: {
        findUnique: jest.fn(async () => ({ recruitedById: null })),
        findFirst: jest.fn(async () => ({
          id: 'recruiter-1',
          username: 'nxr',
          name: 'NXR',
          premium: true,
        })),
        update: jest.fn(async () => ({})),
      },
    };
    const follows = { follow: jest.fn(async () => undefined) };
    const sideEffects = { dispatch: jest.fn() };

    const service = new ReferralService(
      prisma,
      {} as any,
      {} as any,
      follows as any,
      {} as any,
      sideEffects as any,
    );

    return { service, sideEffects, follows };
  }

  it('dispatches auto-verify with the recruiter so the handler can apply the site toggle', async () => {
    const { service, sideEffects } = makeService();

    await service.setRecruiter('u1', 'NXR');

    expect(sideEffects.dispatch).toHaveBeenCalledWith('user.auto-verify', {
      userId: 'u1',
      recruitedById: 'recruiter-1',
      source: 'auto_referral',
    });
  });

  it('still returns the recruiter to the caller', async () => {
    const { service } = makeService();

    await expect(service.setRecruiter('u1', 'NXR')).resolves.toEqual({
      recruiter: { username: 'nxr', name: 'NXR' },
    });
  });
});
