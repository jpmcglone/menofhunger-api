import { ExecutionContext, ForbiddenException, UnauthorizedException } from '@nestjs/common';
import { VerifiedGuard } from './verified.guard';

type FakeUser = { verifiedStatus: string | null; premium: boolean; premiumPlus: boolean } | null;

function makeContext(userId: string | null): ExecutionContext {
  const req = { user: userId ? { id: userId } : undefined };
  return {
    switchToHttp: () => ({ getRequest: () => req }),
  } as unknown as ExecutionContext;
}

function makeGuard(user: FakeUser) {
  const prisma = {
    user: {
      findUnique: jest.fn().mockResolvedValue(user),
    },
  };
  return { guard: new VerifiedGuard(prisma as any), prisma };
}

describe('VerifiedGuard', () => {
  it('rejects unauthenticated requests', async () => {
    const { guard } = makeGuard(null);
    await expect(guard.canActivate(makeContext(null))).rejects.toBeInstanceOf(UnauthorizedException);
  });

  it('rejects when the user record is missing', async () => {
    const { guard } = makeGuard(null);
    await expect(guard.canActivate(makeContext('u1'))).rejects.toBeInstanceOf(UnauthorizedException);
  });

  it('rejects an unverified, non-premium user', async () => {
    const { guard } = makeGuard({ verifiedStatus: 'none', premium: false, premiumPlus: false });
    await expect(guard.canActivate(makeContext('u1'))).rejects.toBeInstanceOf(ForbiddenException);
  });

  it('allows an identity-verified user', async () => {
    const { guard } = makeGuard({ verifiedStatus: 'identity', premium: false, premiumPlus: false });
    await expect(guard.canActivate(makeContext('u1'))).resolves.toBe(true);
  });

  it('allows a premium user even if not identity-verified', async () => {
    const { guard } = makeGuard({ verifiedStatus: 'none', premium: true, premiumPlus: false });
    await expect(guard.canActivate(makeContext('u1'))).resolves.toBe(true);
  });

  it('allows a premiumPlus user', async () => {
    const { guard } = makeGuard({ verifiedStatus: 'none', premium: false, premiumPlus: true });
    await expect(guard.canActivate(makeContext('u1'))).resolves.toBe(true);
  });
});
