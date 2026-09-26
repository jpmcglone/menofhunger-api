import { GUARDS_METADATA } from '@nestjs/common/constants';
import { AuthGuard } from '../auth/auth.guard';
import { VerifiedGuard } from '../auth/verified.guard';
import { MembersMapController } from './members-map.controller';
import { MembersMapService, MEMBERS_MAP_MEMBER_WHERE } from './members-map.service';

describe('MembersMapController', () => {
  it('requires a signed-in, verified viewer for every route', () => {
    expect(Reflect.getMetadata(GUARDS_METADATA, MembersMapController)).toEqual([AuthGuard, VerifiedGuard]);
  });

  it('rejects state values that are not a two-letter code or none', async () => {
    const controller = new MembersMapController({ members: jest.fn() } as any);
    await expect(controller.members({ state: 'Virginia' })).rejects.toThrow();
  });
});

function userRow(id: string) {
  return {
    id,
    username: id,
    name: id.toUpperCase(),
    premium: false,
    premiumPlus: false,
    isOrganization: false,
    accountKind: 'person',
    verifiedStatus: 'identity',
    avatarKey: null,
    avatarVideoKey: null,
    avatarVideoDurationMs: null,
    avatarUpdatedAt: null,
    bannedAt: null,
    isBot: false,
    orgMemberships: [],
  };
}

function makeService(opts: {
  groups: Array<{ locationState: string | null; count: number }>;
  onlineIds?: string[];
  onlineRows?: Array<{ id: string; locationState: string | null }>;
  recentRows?: Array<{ id: string; locationState: string | null }>;
  pageRows?: string[];
}) {
  const findMany = jest.fn(async (args: any) => {
    if (args.select?.locationState && !args.select?.username) return opts.onlineRows ?? [];
    if (args.orderBy) return (opts.pageRows ?? []).map(userRow);
    const ids: string[] = args.where?.id?.in ?? [];
    return ids.map(userRow);
  });
  const prisma = {
    user: {
      groupBy: jest.fn(async () => opts.groups.map((g) => ({ locationState: g.locationState, _count: { _all: g.count } }))),
      findMany,
    },
    $queryRaw: jest.fn(async () => opts.recentRows ?? []),
  };
  const presenceRedis = { onlineUserIds: jest.fn(async () => opts.onlineIds ?? []) };
  const service = new MembersMapService(prisma as any, { r2: () => null } as any, presenceRedis as any);
  return { service, prisma, presenceRedis };
}

describe('MembersMapService.summary', () => {
  it('groups members by state, counts online members, and separates the unlocated bucket', async () => {
    const { service, prisma } = makeService({
      groups: [
        { locationState: 'VA', count: 3 },
        { locationState: 'tx', count: 5 },
        { locationState: null, count: 2 },
        { locationState: '', count: 1 },
      ],
      onlineIds: ['a', 'b', 'c'],
      onlineRows: [
        { id: 'a', locationState: 'VA' },
        { id: 'b', locationState: null },
        { id: 'c', locationState: 'TX' },
      ],
      recentRows: [
        { id: 'd', locationState: 'VA' },
        { id: 'a', locationState: 'VA' },
        { id: 'e', locationState: 'TX' },
      ],
    });

    const result = await service.summary(new Date('2026-09-26T12:00:00Z'));

    expect(prisma.user.groupBy).toHaveBeenCalledWith(expect.objectContaining({ where: MEMBERS_MAP_MEMBER_WHERE }));
    expect(result.states.map((s) => [s.state, s.memberCount, s.onlineCount])).toEqual([
      ['TX', 5, 1],
      ['VA', 3, 1],
    ]);
    expect(result.states[1]?.stateDisplay).toBe('Virginia');
    expect(result.states[1]?.preview.map((u) => u.id)).toEqual(['a', 'd']);
    expect(result.totals).toEqual({ members: 11, states: 2, online: 3, unlocated: 3, unlocatedOnline: 1 });
    expect(result.unlocatedPreview.map((u) => u.id)).toEqual(['b']);
    expect(result.online).toEqual(
      expect.arrayContaining([
        { userId: 'a', state: 'VA' },
        { userId: 'b', state: null },
        { userId: 'c', state: 'TX' },
      ]),
    );
    expect(result.asOf).toBe('2026-09-26T12:00:00.000Z');
  });

  it('only hydrates online members who pass the member filter', async () => {
    const { service, prisma } = makeService({ groups: [], onlineIds: ['x'], onlineRows: [] });
    const result = await service.summary();
    expect(prisma.user.findMany).toHaveBeenCalledWith({
      where: { ...MEMBERS_MAP_MEMBER_WHERE, id: { in: ['x'] } },
      select: { id: true, locationState: true },
    });
    expect(result.totals.online).toBe(0);
    expect(result.states).toEqual([]);
  });
});

describe('MembersMapService.members', () => {
  it('leads the first page with online members and excludes them from the paged remainder', async () => {
    const { service, prisma } = makeService({ groups: [], onlineIds: ['on1'], pageRows: ['p1', 'p2', 'p3'] });
    const result = await service.members({ state: 'VA', cursor: null, limit: 2 });

    expect(result.users.map((u) => u.id)).toEqual(['on1', 'p1', 'p2']);
    expect(result.nextCursor).toBe('2');
    const pagedCall = prisma.user.findMany.mock.calls.find(([args]: any[]) => args.orderBy)?.[0];
    expect(pagedCall.where).toMatchObject({
      ...MEMBERS_MAP_MEMBER_WHERE,
      locationState: { equals: 'VA', mode: 'insensitive' },
      id: { notIn: ['on1'] },
    });
    expect(pagedCall.skip).toBe(0);
    expect(pagedCall.take).toBe(3);
  });

  it('selects members without a location for the none bucket and skips online on later pages', async () => {
    const { service, prisma } = makeService({ groups: [], onlineIds: ['on1'], pageRows: ['p9'] });
    const result = await service.members({ state: 'none', cursor: '40', limit: 20 });

    expect(result.users.map((u) => u.id)).toEqual(['p9']);
    expect(result.nextCursor).toBeNull();
    const calls = prisma.user.findMany.mock.calls.map(([args]: any[]) => args);
    expect(calls).toHaveLength(1);
    expect(calls[0].where.OR).toEqual([{ locationState: null }, { locationState: '' }]);
    expect(calls[0].skip).toBe(40);
  });
});
