import { FollowsService } from './follows.service';

function makeRow(overrides: Partial<any> = {}) {
  return {
    id: 'user-1',
    username: 'user1',
    name: 'User One',
    premium: false,
    premiumPlus: false,
    isOrganization: false,
    stewardBadgeEnabled: false,
    verifiedStatus: 'none',
    avatarKey: null,
    avatarUpdatedAt: null,
    createdAt: new Date('2026-01-01T00:00:00.000Z'),
    mutualCount: 0,
    overlapCount: 0,
    followsViewer: false,
    ...overrides,
  };
}

function makeService(rows: any[]) {
  const prisma: any = {
    $queryRaw: jest.fn(async () => rows),
    follow: {
      findMany: jest.fn(async () => []),
    },
    userOrgMembership: {
      findMany: jest.fn(async () => []),
    },
  };
  const appConfig: any = { r2: jest.fn(() => null) };
  const redis: any = {
    getJson: jest.fn(async () => null),
    setJson: jest.fn(async () => undefined),
  };
  const service = new FollowsService(
    prisma,
    appConfig,
    {} as any,
    redis,
    {} as any,
    {} as any,
    {} as any,
  );

  return { service, prisma, redis };
}

describe('FollowsService recommendations ranking', () => {
  beforeEach(() => {
    jest.spyOn(Date, 'now').mockReturnValue(new Date('2026-04-01T00:00:00.000Z').getTime());
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  it('keeps strong mutual-follow recommendations ahead of weak polished fallbacks', async () => {
    const { service } = makeService([
      makeRow({
        id: 'polished-fallback',
        username: 'polished',
        verifiedStatus: 'identity',
        premiumPlus: true,
        avatarKey: 'avatar.png',
        createdAt: new Date('2026-03-31T00:00:00.000Z'),
      }),
      makeRow({
        id: 'mutual',
        username: 'mutual',
        mutualCount: 2,
        createdAt: new Date('2025-01-01T00:00:00.000Z'),
      }),
    ]);

    const result = await service.recommendUsersToFollow({
      viewerUserId: 'viewer',
      limit: 2,
      seed: 'refresh-a',
    });

    expect(result.users.map((u) => u.id)).toEqual(['mutual', 'polished-fallback']);
  });

  it('uses shared interest overlap as a strong relevance signal', async () => {
    const { service } = makeService([
      makeRow({
        id: 'trusted',
        username: 'trusted',
        verifiedStatus: 'identity',
        premiumPlus: true,
        avatarKey: 'avatar.png',
      }),
      makeRow({
        id: 'shared-interests',
        username: 'shared',
        overlapCount: 2,
      }),
    ]);

    const result = await service.recommendUsersToFollow({
      viewerUserId: 'viewer',
      limit: 2,
      seed: 'refresh-a',
    });

    expect(result.users.map((u) => u.id)).toEqual(['shared-interests', 'trusted']);
  });

  it('allows close candidates to rotate when the refresh seed changes', async () => {
    const rows = Array.from({ length: 10 }, (_, index) =>
      makeRow({
        id: `candidate-${index}`,
        username: `candidate${index}`,
      }),
    );
    const { service } = makeService(rows);

    const first = await service.recommendUsersToFollow({
      viewerUserId: 'viewer',
      limit: 5,
      seed: 'refresh-a',
    });
    const second = await service.recommendUsersToFollow({
      viewerUserId: 'viewer',
      limit: 5,
      seed: 'refresh-b',
    });

    expect(second.users.map((u) => u.id)).not.toEqual(first.users.map((u) => u.id));
  });

  it('caches recommendation results per seed', async () => {
    const { service, redis } = makeService([makeRow({ id: 'candidate', username: 'candidate' })]);

    await service.recommendUsersToFollow({ viewerUserId: 'viewer', limit: 1, seed: 'refresh-a' });
    await service.recommendUsersToFollow({ viewerUserId: 'viewer', limit: 1, seed: 'refresh-b' });

    const cacheKeys = redis.getJson.mock.calls.map(([key]: [string]) => key);
    expect(cacheKeys).toHaveLength(2);
    expect(cacheKeys[0]).not.toBe(cacheKeys[1]);
  });
});
