import {
  BadRequestException,
  ForbiddenException,
  NotFoundException,
  UnauthorizedException,
} from '@nestjs/common';
import { ImpersonationService } from './impersonation.service';

type MakeOpts = {
  admin?: Record<string, unknown> | null;
  target?: Record<string, unknown> | null;
};

/** Minimal row shape that `toUserDto` can map (only `createdAt` is read unguarded). */
function userRow(over: Record<string, unknown>) {
  return { createdAt: new Date('2026-01-01T00:00:00.000Z'), ...over };
}

function makeService(opts: MakeOpts = {}) {
  const admin =
    opts.admin === undefined
      ? userRow({ id: 'admin-1', username: 'boss', siteAdmin: true, bannedAt: null })
      : opts.admin;
  const target =
    opts.target === undefined
      ? userRow({ id: 'target-1', username: 'regular', siteAdmin: false, bannedAt: null })
      : opts.target;

  const impersonationLogCreate = jest.fn(async () => ({ id: 'log-1' }));
  const impersonationLogUpdateMany = jest.fn(async () => ({ count: 1 }));
  const prisma = {
    user: {
      findUnique: jest.fn(async ({ where }: any) =>
        where.id === 'admin-1' ? admin : where.id === 'target-1' ? target : null,
      ),
      findFirst: jest.fn(async () => target),
    },
    adminImpersonationLog: {
      create: impersonationLogCreate,
      updateMany: impersonationLogUpdateMany,
    },
  } as any;

  const createSessionForUser = jest.fn(async () => ({ id: 'session-new' }));
  const revokeSessionToken = jest.fn(async () => undefined);
  const clearAuthCookie = jest.fn();
  const meFromSessionToken = jest.fn(async () => ({
    user: { id: 'target-1', username: 'regular' },
    sessionId: 'session-imp',
    expiresAt: new Date(),
    renewed: false,
    impersonatedByUserId: 'admin-1',
  }));
  const auth = {
    createSessionForUser,
    revokeSessionToken,
    clearAuthCookie,
    meFromSessionToken,
  } as any;

  const appConfig = { r2: () => ({ publicBaseUrl: null }) } as any;
  const slack = { send: jest.fn(async () => undefined) } as any;

  const service = new ImpersonationService(prisma, appConfig, auth, slack);
  return {
    service,
    prisma,
    createSessionForUser,
    revokeSessionToken,
    clearAuthCookie,
    meFromSessionToken,
    impersonationLogCreate,
    impersonationLogUpdateMany,
    slack,
  };
}

const res = () => ({ cookie: jest.fn(), clearCookie: jest.fn() }) as any;

describe('ImpersonationService.start', () => {
  it('mints a session for the target that records the acting admin', async () => {
    const { service, createSessionForUser, impersonationLogCreate } = makeService();

    await service.start('admin-1', 'regular', res());

    expect(createSessionForUser).toHaveBeenCalledWith('target-1', expect.anything(), {
      impersonatedByUserId: 'admin-1',
    });
    expect(impersonationLogCreate).toHaveBeenCalledWith({
      data: { adminUserId: 'admin-1', targetUserId: 'target-1', sessionId: 'session-new' },
    });
  });

  it('accepts a username with a leading @ and mixed case', async () => {
    const { service, prisma } = makeService();

    await service.start('admin-1', '  @ReGuLaR ', res());

    expect(prisma.user.findFirst).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { username: { equals: 'regular', mode: 'insensitive' } },
      }),
    );
  });

  it('refuses to impersonate another site admin', async () => {
    const { service, createSessionForUser } = makeService({
      target: userRow({ id: 'target-1', username: 'otheradmin', siteAdmin: true, bannedAt: null }),
    });

    await expect(service.start('admin-1', 'otheradmin', res())).rejects.toBeInstanceOf(
      ForbiddenException,
    );
    expect(createSessionForUser).not.toHaveBeenCalled();
  });

  it('refuses to impersonate a banned account', async () => {
    const { service, createSessionForUser } = makeService({
      target: userRow({
        id: 'target-1',
        username: 'banned',
        siteAdmin: false,
        bannedAt: new Date(),
      }),
    });

    await expect(service.start('admin-1', 'banned', res())).rejects.toBeInstanceOf(
      BadRequestException,
    );
    expect(createSessionForUser).not.toHaveBeenCalled();
  });

  it('refuses when the caller is no longer a site admin', async () => {
    const { service, createSessionForUser } = makeService({
      admin: userRow({ id: 'admin-1', username: 'boss', siteAdmin: false, bannedAt: null }),
    });

    await expect(service.start('admin-1', 'regular', res())).rejects.toBeInstanceOf(
      NotFoundException,
    );
    expect(createSessionForUser).not.toHaveBeenCalled();
  });

  it('404s when the target username does not exist', async () => {
    const { service, createSessionForUser } = makeService({ target: null });

    await expect(service.start('admin-1', 'ghost', res())).rejects.toBeInstanceOf(
      NotFoundException,
    );
    expect(createSessionForUser).not.toHaveBeenCalled();
  });

  it('refuses to impersonate yourself', async () => {
    const { service, createSessionForUser } = makeService({
      target: userRow({ id: 'admin-1', username: 'boss', siteAdmin: true, bannedAt: null }),
    });

    await expect(service.start('admin-1', 'boss', res())).rejects.toBeInstanceOf(
      BadRequestException,
    );
    expect(createSessionForUser).not.toHaveBeenCalled();
  });
});

describe('ImpersonationService.stop', () => {
  it('revokes the impersonation session and restores an admin session', async () => {
    const { service, revokeSessionToken, createSessionForUser, impersonationLogUpdateMany } =
      makeService();

    const result = await service.stop('imp-token', res());

    expect(revokeSessionToken).toHaveBeenCalledWith('imp-token');
    expect(impersonationLogUpdateMany).toHaveBeenCalledWith({
      where: { sessionId: 'session-imp', endedAt: null },
      data: { endedAt: expect.any(Date) },
    });
    expect(createSessionForUser).toHaveBeenCalledWith('admin-1', expect.anything());
    expect(result.signedOut).toBe(false);
  });

  it('rejects an ordinary (non-impersonation) session', async () => {
    const { service, meFromSessionToken, revokeSessionToken } = makeService();
    meFromSessionToken.mockResolvedValueOnce({
      user: { id: 'user-1', username: 'someone' },
      sessionId: 'session-1',
      expiresAt: new Date(),
      renewed: false,
      impersonatedByUserId: null,
    } as any);

    await expect(service.stop('plain-token', res())).rejects.toBeInstanceOf(BadRequestException);
    expect(revokeSessionToken).not.toHaveBeenCalled();
  });

  it('requires a session token', async () => {
    const { service } = makeService();
    await expect(service.stop(undefined, res())).rejects.toBeInstanceOf(UnauthorizedException);
  });

  it('signs out instead of restoring when the admin account is banned', async () => {
    const { service, clearAuthCookie, createSessionForUser } = makeService({
      admin: userRow({ id: 'admin-1', username: 'boss', siteAdmin: true, bannedAt: new Date() }),
    });

    const result = await service.stop('imp-token', res());

    expect(clearAuthCookie).toHaveBeenCalled();
    expect(createSessionForUser).not.toHaveBeenCalled();
    expect(result.signedOut).toBe(true);
    expect(result.user).toBeNull();
  });
});
