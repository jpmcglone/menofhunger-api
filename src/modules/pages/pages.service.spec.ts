import { BadRequestException, ConflictException, NotFoundException } from '@nestjs/common';
import { AccountKind } from '@prisma/client';
import { PagesService } from './pages.service';

function makeService(overrides: { prisma?: any; auth?: any; entitlements?: any } = {}) {
  const prisma: any = {
    user: {
      findUnique: jest.fn(),
      findFirst: jest.fn(),
      create: jest.fn(),
      update: jest.fn(),
    },
    userPageOperator: {
      create: jest.fn(async () => ({})),
      count: jest.fn(async () => 0),
      findMany: jest.fn(async () => []),
      deleteMany: jest.fn(async () => ({ count: 1 })),
    },
    userOrgMembership: {
      create: jest.fn(async () => ({})),
    },
    parkedPhone: {
      upsert: jest.fn(async () => ({})),
      deleteMany: jest.fn(async () => ({ count: 0 })),
    },
    $transaction: jest.fn(async (fn: any) => fn(prisma)),
    ...overrides.prisma,
  };
  const auth = { revokeAllSessionsForUser: jest.fn(async () => undefined), ...overrides.auth };
  const entitlements = { recomputeAndApply: jest.fn(async () => ({})), ...overrides.entitlements };
  const appConfig = { r2: jest.fn(() => null) };
  const svc = new PagesService(prisma as any, auth as any, entitlements as any, appConfig as any);
  return { svc, prisma, auth, entitlements };
}

describe('PagesService.createPage', () => {
  it('creates a phoneless page and links the operator', async () => {
    const { svc, prisma } = makeService();
    prisma.user.findUnique.mockImplementation(async ({ where }: { where: { id: string } }) => {
      if (where.id === 'op-1') {
        return {
          id: 'op-1',
          username: 'john',
          name: 'John',
          avatarKey: null,
          avatarUpdatedAt: null,
          accountKind: AccountKind.person,
          bannedAt: null,
          premium: true,
          verifiedStatus: 'manual',
        };
      }
      return {
        id: 'page-1',
        username: 'mohnews',
        name: 'MOH News',
        accountKind: AccountKind.page,
        isOrganization: false,
      };
    });
    prisma.user.findFirst.mockResolvedValue(null);
    prisma.user.create.mockResolvedValue({ id: 'page-1' });
    prisma.userPageOperator.findMany.mockResolvedValue([]);

    const result = await svc.createPage({
      username: 'mohnews',
      name: 'MOH News',
      isOrganization: false,
      operatorUserId: 'op-1',
    });

    expect(prisma.user.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          accountKind: AccountKind.page,
          phone: null,
          username: 'mohnews',
          usernameIsSet: true,
        }),
      }),
    );
    expect(prisma.userPageOperator.create).toHaveBeenCalledWith({
      data: { pageUserId: 'page-1', operatorUserId: 'op-1' },
    });
    expect(result.id).toBe('page-1');
  });

  it('rejects a taken username', async () => {
    const { svc, prisma } = makeService();
    prisma.user.findUnique.mockResolvedValue({
      id: 'op-1',
      accountKind: AccountKind.person,
      bannedAt: null,
      premium: true,
      verifiedStatus: 'manual',
    });
    prisma.user.findFirst.mockResolvedValue({ id: 'other' });

    await expect(
      svc.createPage({
        username: 'mohnews',
        name: 'MOH News',
        isOrganization: false,
        operatorUserId: 'op-1',
      }),
    ).rejects.toBeInstanceOf(ConflictException);
  });
});

describe('PagesService.convertToPage', () => {
  it('clears the phone, flips kind, and revokes sessions', async () => {
    const { svc, prisma, auth } = makeService();
    let converted = false;
    prisma.user.update.mockImplementation(async () => {
      converted = true;
      return { id: 'src-1' };
    });
    prisma.user.findUnique.mockImplementation(async ({ where }: any) => {
      if (where.id === 'src-1') {
        return {
          id: 'src-1',
          phone: converted ? null : '+15550001111',
          accountKind: converted ? AccountKind.page : AccountKind.person,
          siteAdmin: false,
          isOrganization: true,
          bannedAt: null,
          username: 'menofhunger',
          name: 'Men of Hunger',
        };
      }
      if (where.id === 'op-1') {
        return {
          id: 'op-1',
          username: 'john',
          name: 'John',
          avatarKey: null,
          avatarUpdatedAt: null,
          accountKind: AccountKind.person,
          bannedAt: null,
          premium: true,
          verifiedStatus: 'manual',
        };
      }
      return null;
    });

    await svc.convertToPage('src-1', 'op-1');

    expect(prisma.user.update).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: 'src-1' },
        data: expect.objectContaining({
          accountKind: AccountKind.page,
          phone: null,
        }),
      }),
    );
    expect(prisma.parkedPhone.upsert).not.toHaveBeenCalled();
    expect(prisma.parkedPhone.deleteMany).toHaveBeenCalledWith({
      where: {
        OR: [{ formerUserId: 'src-1' }, { phone: '+15550001111' }],
      },
    });
    expect(auth.revokeAllSessionsForUser).toHaveBeenCalledWith('src-1');
    expect(prisma.userOrgMembership.create).toHaveBeenCalled();
  });

  it('refuses to convert a site admin', async () => {
    const { svc, prisma } = makeService();
    prisma.user.findUnique.mockResolvedValue({
      id: 'src-1',
      phone: '+15550001111',
      accountKind: AccountKind.person,
      siteAdmin: true,
      isOrganization: false,
    });

    await expect(svc.convertToPage('src-1', 'op-1')).rejects.toBeInstanceOf(BadRequestException);
  });

  it('refuses when the source already operates pages', async () => {
    const { svc, prisma } = makeService();
    prisma.user.findUnique.mockResolvedValue({
      id: 'src-1',
      phone: '+15550001111',
      accountKind: AccountKind.person,
      siteAdmin: false,
      isOrganization: false,
    });
    prisma.userPageOperator.count.mockResolvedValue(1);

    await expect(svc.convertToPage('src-1', 'op-1')).rejects.toBeInstanceOf(BadRequestException);
  });
});

describe('PagesService.operators', () => {
  it('throws when adding an operator to a person account', async () => {
    const { svc, prisma } = makeService();
    prisma.user.findUnique.mockResolvedValue({
      id: 'u1',
      accountKind: AccountKind.person,
      isOrganization: false,
    });

    await expect(svc.addOperator('u1', 'op-1')).rejects.toBeInstanceOf(BadRequestException);
  });

  it('throws when removing a missing operator', async () => {
    const { svc, prisma } = makeService();
    prisma.userPageOperator.deleteMany.mockResolvedValue({ count: 0 });

    await expect(svc.removeOperator('page-1', 'op-1')).rejects.toBeInstanceOf(NotFoundException);
  });
});
