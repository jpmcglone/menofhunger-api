import { ForbiddenException } from '@nestjs/common';
import { AccountKind } from '@prisma/client';
import { AccountSwitchService } from './account-switch.service';

function makeService(overrides: { prisma?: any; auth?: any } = {}) {
  const prisma = {
    user: { findUnique: jest.fn(), findMany: jest.fn(async () => []) },
    userPageOperator: { findMany: jest.fn(async () => []), findUnique: jest.fn() },
    $queryRaw: jest.fn(async () => []),
    ...overrides.prisma,
  };
  const auth = {
    revokeSessionToken: jest.fn(async () => undefined),
    createSessionForUser: jest.fn(async () => ({ id: 'sess' })),
    ...overrides.auth,
  };
  const appConfig = { r2: jest.fn(() => null) };
  const svc = new AccountSwitchService(prisma as any, appConfig as any, auth as any);
  return { svc, prisma, auth };
}

describe('AccountSwitchService', () => {
  it('lists the person plus operated pages', async () => {
    const { svc, prisma } = makeService();
    prisma.user.findUnique.mockResolvedValue({
      id: 'john',
      username: 'john',
      name: 'John',
      avatarKey: null,
      avatarUpdatedAt: null,
      accountKind: AccountKind.person,
      isOrganization: false,
      bannedAt: null,
    });
    prisma.user.findMany.mockResolvedValue([
      { id: 'john', undeliveredNotificationCount: 2, undeliveredGroupPostCount: 1 },
      { id: 'news', undeliveredNotificationCount: 4, undeliveredGroupPostCount: 0 },
    ]);
    prisma.$queryRaw.mockResolvedValue([{ userId: 'news', count: 3 }]);
    prisma.userPageOperator.findMany.mockResolvedValue([
      {
        page: {
          id: 'news',
          username: 'mohnews',
          name: 'News',
          avatarKey: null,
          avatarUpdatedAt: null,
          accountKind: AccountKind.page,
          isOrganization: false,
          bannedAt: null,
        },
      },
    ]);

    const accounts = await svc.listAccounts({
      effectiveUserId: 'john',
      operatedByUserId: null,
      accountKind: AccountKind.person,
    });

    expect(accounts).toHaveLength(2);
    expect(accounts[0]).toMatchObject({ id: 'john', isCurrent: true, accountKind: 'person', unreadBadgeCount: 3 });
    expect(accounts[1]).toMatchObject({ id: 'news', isCurrent: false, accountKind: 'page', unreadBadgeCount: 7 });
  });

  it('lists token owners as operators for a page', async () => {
    const { svc, prisma } = makeService();
    prisma.user.findUnique.mockResolvedValue({ accountKind: AccountKind.page });
    prisma.userPageOperator.findMany.mockResolvedValue([{ operatorUserId: 'john' }]);
    await expect(svc.listTokenOwnerIds('news')).resolves.toEqual(['john']);
  });

  it('lists a person as their own token owner', async () => {
    const { svc, prisma } = makeService();
    prisma.user.findUnique.mockResolvedValue({ accountKind: AccountKind.person });
    await expect(svc.listTokenOwnerIds('john')).resolves.toEqual(['john']);
  });

  it('rejects switch while impersonating', async () => {
    const { svc } = makeService();
    await expect(
      svc.switchTo({
        currentUserId: 'john',
        operatedByUserId: null,
        impersonatedByUserId: 'admin-1',
        accountKind: AccountKind.person,
        targetUserId: 'news',
        currentToken: 'tok',
        res: {} as any,
      }),
    ).rejects.toBeInstanceOf(ForbiddenException);
  });

  it('mints a page session with operatedByUserId', async () => {
    const { svc, prisma, auth } = makeService();
    prisma.userPageOperator.findUnique.mockResolvedValue({ pageUserId: 'news' });
    prisma.user.findUnique.mockResolvedValue({
      id: 'news',
      createdAt: new Date(),
      phone: null,
      accountKind: AccountKind.page,
      email: null,
      emailVerifiedAt: null,
      emailVerificationRequestedAt: null,
      username: 'mohnews',
      usernameIsSet: true,
      name: 'News',
      bio: null,
      website: null,
      xUsername: null,
      pickaxUsername: null,
      locationInput: null,
      locationDisplay: null,
      locationZip: null,
      locationCity: null,
      locationCounty: null,
      locationState: null,
      locationCountry: null,
      birthdate: null,
      interests: [],
      menOnlyConfirmed: true,
      siteAdmin: false,
      featureToggles: [],
      bannedAt: null,
      bannedReason: null,
      bannedByAdminId: null,
      premium: true,
      premiumPlus: false,
      isOrganization: false,
      verifiedStatus: 'manual',
      verifiedAt: new Date(),
      unverifiedAt: null,
      followVisibility: 'all',
      birthdayVisibility: 'monthDay',
      avatarKey: null,
      avatarUpdatedAt: null,
      bannerKey: null,
      bannerUpdatedAt: null,
      pinnedPostId: null,
      coins: 0,
      checkinStreakDays: 0,
      lastCheckinDayKey: null,
      longestStreakDays: 0,
      locationPromptSkipped: true,
      openToCrewAt: null,
    });

    const res = { cookie: jest.fn() } as any;
    await svc.switchTo({
      currentUserId: 'john',
      operatedByUserId: null,
      impersonatedByUserId: null,
      accountKind: AccountKind.person,
      targetUserId: 'news',
      currentToken: 'tok',
      res,
    });

    expect(auth.revokeSessionToken).toHaveBeenCalledWith('tok');
    expect(auth.createSessionForUser).toHaveBeenCalledWith('news', res, { operatedByUserId: 'john' });
  });

  it('clears operatedByUserId when switching home', async () => {
    const { svc, prisma, auth } = makeService();
    prisma.user.findUnique.mockResolvedValue({
      id: 'john',
      createdAt: new Date(),
      phone: '+1',
      accountKind: AccountKind.person,
      email: null,
      emailVerifiedAt: null,
      emailVerificationRequestedAt: null,
      username: 'john',
      usernameIsSet: true,
      name: 'John',
      bio: null,
      website: null,
      xUsername: null,
      pickaxUsername: null,
      locationInput: null,
      locationDisplay: null,
      locationZip: null,
      locationCity: null,
      locationCounty: null,
      locationState: null,
      locationCountry: null,
      birthdate: null,
      interests: [],
      menOnlyConfirmed: true,
      siteAdmin: false,
      featureToggles: [],
      bannedAt: null,
      bannedReason: null,
      bannedByAdminId: null,
      premium: true,
      premiumPlus: false,
      isOrganization: false,
      verifiedStatus: 'manual',
      verifiedAt: new Date(),
      unverifiedAt: null,
      followVisibility: 'all',
      birthdayVisibility: 'monthDay',
      avatarKey: null,
      avatarUpdatedAt: null,
      bannerKey: null,
      bannerUpdatedAt: null,
      pinnedPostId: null,
      coins: 0,
      checkinStreakDays: 0,
      lastCheckinDayKey: null,
      longestStreakDays: 0,
      locationPromptSkipped: true,
      openToCrewAt: null,
    });

    const res = { cookie: jest.fn() } as any;
    await svc.switchTo({
      currentUserId: 'news',
      operatedByUserId: 'john',
      impersonatedByUserId: null,
      accountKind: AccountKind.page,
      targetUserId: 'john',
      currentToken: 'tok',
      res,
    });

    expect(auth.createSessionForUser).toHaveBeenCalledWith('john', res, { operatedByUserId: null });
  });
});
