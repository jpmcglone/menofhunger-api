import { IdentityVerifiedGuard } from './identity-verified.guard';
const context = { switchToHttp: () => ({ getRequest: () => ({ user: { id: 'u1' } }) }) } as any;
describe('Fitness identity prerequisite', () => {
  it.each(['identity', 'manual'])('allows %s without paid membership', async verifiedStatus => {
    const guard = new IdentityVerifiedGuard({ user: { findUnique: async () => ({ verifiedStatus, premium: false }) } } as any);
    expect(await guard.canActivate(context)).toBe(true);
  });
  it('denies an unverified account even if an old premium flag remains', async () => {
    const guard = new IdentityVerifiedGuard({ user: { findUnique: async () => ({ verifiedStatus: 'none', premium: true }) } } as any);
    await expect(guard.canActivate(context)).rejects.toThrow('Verify your account');
  });
});
