import { NotFoundException } from '@nestjs/common';
import type { ExecutionContext } from '@nestjs/common';
import { AdminGuard } from '../admin/admin.guard';

/**
 * Verifies that every admin-scoped Marv endpoint is gated by `AdminGuard`,
 * and that the guard hides existence (404, not 401/403) for non-admins.
 *
 * The guard itself lives in `../admin/admin.guard.ts`; here we exercise it
 * directly with a fake request to assert the contract on which the
 * `/admin/marvin/*` routes rely.
 */

function makeAuthMock(opts: {
  authenticated: boolean;
  siteAdmin: boolean;
}): { meFromSessionToken: jest.Mock } {
  const result = opts.authenticated
    ? {
        user: { id: 'u-1', siteAdmin: opts.siteAdmin },
        renewed: false,
        expiresAt: new Date(),
      }
    : null;
  return {
    meFromSessionToken: jest.fn(async () => result),
  };
}

function makeContext(req: Record<string, any> = {}): ExecutionContext {
  const fakeReq = { headers: {}, cookies: {}, ...req } as any;
  const fakeRes = { cookie: jest.fn(), clearCookie: jest.fn() } as any;
  return {
    switchToHttp: () => ({
      getRequest: () => fakeReq,
      getResponse: () => fakeRes,
    }),
  } as any;
}

describe('AdminGuard — Marv admin endpoints', () => {
  it('throws 404 (NotFoundException) for unauthenticated requests', async () => {
    const auth = makeAuthMock({ authenticated: false, siteAdmin: false }) as any;
    const guard = new AdminGuard(auth);
    await expect(guard.canActivate(makeContext())).rejects.toBeInstanceOf(NotFoundException);
  });

  it('throws 404 (NotFoundException) for authenticated NON-admins', async () => {
    const auth = makeAuthMock({ authenticated: true, siteAdmin: false }) as any;
    const guard = new AdminGuard(auth);
    await expect(guard.canActivate(makeContext())).rejects.toBeInstanceOf(NotFoundException);
  });

  it('allows authenticated admins through and stamps `req.user.id`', async () => {
    const auth = makeAuthMock({ authenticated: true, siteAdmin: true }) as any;
    const guard = new AdminGuard(auth);
    const fakeReq: any = {};
    const ctx = {
      switchToHttp: () => ({
        getRequest: () => fakeReq,
        getResponse: () => ({}),
      }),
    } as ExecutionContext;
    await expect(guard.canActivate(ctx)).resolves.toBe(true);
    expect(fakeReq.user).toEqual({ id: 'u-1' });
  });
});
