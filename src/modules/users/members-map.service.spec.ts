import { GUARDS_METADATA } from '@nestjs/common/constants';
import { AuthGuard } from '../auth/auth.guard';
import { OptionalAuthGuard } from '../auth/optional-auth.guard';
import { VerifiedGuard } from '../auth/verified.guard';
import { canSeeMembers } from '../auth/member-visibility';
import { MembersMapController } from './members-map.controller';
import { UserLookupService } from '../user-lookup/user-lookup.service';
import { MembersMapService, membersMapMemberWhere } from './members-map.service';

describe('MembersMapController', () => {
  it('opens the summary to everyone but keeps the member list verified-only', () => {
    const proto = MembersMapController.prototype;
    expect(Reflect.getMetadata(GUARDS_METADATA, proto.summary)).toEqual([OptionalAuthGuard]);
    expect(Reflect.getMetadata(GUARDS_METADATA, proto.members)).toEqual([AuthGuard, VerifiedGuard]);
  });

  it('asks for the counts-only summary when the viewer is signed out or unverified', async () => {
    const membersMap = { summary: jest.fn(async () => ({})) };
    const prisma = { user: { findUnique: jest.fn(async () => ({ verifiedStatus: 'none', premium: false, premiumPlus: false, siteAdmin: false })) } };
    const controller = new MembersMapController(membersMap as any, new UserLookupService(prisma as any));
    await controller.summary(undefined);
    await controller.summary('unverified');
    expect(membersMap.summary).toHaveBeenNthCalledWith(1, { membersVisible: false, viewerUserId: null });
    expect(membersMap.summary).toHaveBeenNthCalledWith(2, { membersVisible: false, viewerUserId: 'unverified' });
  });

  it('rejects state values that are not a two-letter code or none', async () => {
    const controller = new MembersMapController({ members: jest.fn() } as any, {} as any);
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
  /** Online members in connect order (oldest first), as the shared roster returns them. */
  online?: Array<{ id: string; locationState: string | null }>;
  marv?: { id: string; locationState: string | null } | null;
  recentRows?: Array<{ id: string; locationState: string | null }>;
  pageRows?: string[];
}) {
  const findMany = jest.fn(async (args: any) => {
    if (args.orderBy) return (opts.pageRows ?? []).map(userRow);
    const ids: string[] = args.where?.id?.in ?? args.where?.AND?.find((c: any) => c.id?.in)?.id?.in ?? [];
    return ids.map(userRow);
  });
  const prisma = {
    user: {
      groupBy: jest.fn(async () => opts.groups.map((g) => ({ locationState: g.locationState, _count: { _all: g.count } }))),
      findMany,
    },
    $queryRaw: jest.fn(async () => opts.recentRows ?? []),
  };
  const online = opts.online ?? [];
  const marv = opts.marv ?? null;
  const onlineMembers = {
    resolve: jest.fn(async () => ({
      connectedIds: online.map((o) => o.id),
      memberIds: online.map((o) => o.id),
      sourceByDisplayedId: new Map(online.map((o) => [o.id, o.id])),
      locationById: new Map([...online, ...(marv ? [marv] : [])].map((o) => [o.id, o.locationState])),
      marvId: marv?.id ?? null,
      total: online.length + (marv ? 1 : 0),
    })),
  };
  const store = new Map<string, unknown>();
  const redis = {
    getJson: jest.fn(async (key: string) => store.get(key) ?? null),
    setJson: jest.fn(async (key: string, value: unknown) => void store.set(key, value)),
  };
  const service = new MembersMapService(prisma as any, { r2: () => null } as any, redis as any, onlineMembers as any);
  return { service, prisma, redis, onlineMembers };
}

describe('MembersMapService.summary', () => {
  it('groups members by state, counts online members, and separates the unlocated bucket', async () => {
    const { service, prisma, onlineMembers } = makeService({
      groups: [
        { locationState: 'VA', count: 3 },
        { locationState: 'tx', count: 5 },
        { locationState: null, count: 2 },
        { locationState: '', count: 1 },
      ],
      online: [
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

    const result = await service.summary({ membersVisible: true, viewerUserId: 'viewer', now: new Date('2026-09-26T12:00:00Z') });

    expect(onlineMembers.resolve).toHaveBeenCalledWith({ viewerUserId: 'viewer', includeViewer: true });
    expect(prisma.user.groupBy).toHaveBeenCalledWith(expect.objectContaining({ where: membersMapMemberWhere(null) }));
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
    expect(result.membersVisible).toBe(true);
  });

  it('reports the same online total as the shared roster, Marv included', async () => {
    const { service, prisma } = makeService({
      groups: [{ locationState: 'VA', count: 2 }, { locationState: null, count: 3 }],
      online: [{ id: 'a', locationState: 'VA' }, { id: 'page-1', locationState: null }],
      marv: { id: 'marv', locationState: null },
    });

    const result = await service.summary({ membersVisible: false });

    expect(result.totals.online).toBe(3);
    expect(result.totals.unlocatedOnline).toBe(2);
    expect(result.states[0]?.onlineCount).toBe(1);
    expect(prisma.user.groupBy).toHaveBeenCalledWith(expect.objectContaining({ where: membersMapMemberWhere('marv') }));
  });

  it('gives limited viewers the same counts with no faces or ids, from a shared cache', async () => {
    const { service, prisma, redis } = makeService({
      groups: [{ locationState: 'VA', count: 3 }, { locationState: null, count: 1 }],
      online: [{ id: 'a', locationState: 'VA' }, { id: 'b', locationState: null }],
      recentRows: [{ id: 'd', locationState: 'VA' }],
    });

    const first = await service.summary({ membersVisible: false });
    const second = await service.summary({ membersVisible: false });

    expect(first.membersVisible).toBe(false);
    expect(first.states).toEqual([
      { state: 'VA', stateDisplay: 'Virginia', memberCount: 3, onlineCount: 1, preview: [] },
    ]);
    expect(first.online).toEqual([]);
    expect(first.unlocatedPreview).toEqual([]);
    expect(first.totals).toEqual({ members: 4, states: 1, online: 2, unlocated: 1, unlocatedOnline: 1 });
    expect(prisma.$queryRaw).not.toHaveBeenCalled();
    expect(second).toEqual(first);
    expect(prisma.user.groupBy).toHaveBeenCalledTimes(1);
    expect(redis.setJson).toHaveBeenCalledTimes(1);
  });
});

describe('MembersMapService.members', () => {
  it('leads the first page with online members and excludes them from the paged remainder', async () => {
    const { service, prisma } = makeService({ groups: [], online: [{ id: 'on1', locationState: 'VA' }], pageRows: ['p1', 'p2', 'p3'] });
    const result = await service.members({ state: 'VA', cursor: null, limit: 2 });

    expect(result.users.map((u) => u.id)).toEqual(['on1', 'p1', 'p2']);
    expect(result.nextCursor).toBe('2');
    const pagedCall = prisma.user.findMany.mock.calls.find(([args]: any[]) => args.orderBy)?.[0];
    expect(pagedCall.where).toEqual({
      AND: [membersMapMemberWhere(null), { locationState: { equals: 'VA', mode: 'insensitive' } }, { id: { notIn: ['on1'] } }],
    });
    expect(pagedCall.skip).toBe(0);
    expect(pagedCall.take).toBe(3);
  });

  it('selects members without a location for the none bucket and skips online on later pages', async () => {
    const { service, prisma } = makeService({ groups: [], online: [{ id: 'on1', locationState: null }], pageRows: ['p9'] });
    const result = await service.members({ state: 'none', cursor: '40', limit: 20 });

    expect(result.users.map((u) => u.id)).toEqual(['p9']);
    expect(result.nextCursor).toBeNull();
    const calls = prisma.user.findMany.mock.calls.map(([args]: any[]) => args);
    expect(calls).toHaveLength(1);
    expect(calls[0].where.AND[1]).toEqual({ OR: [{ locationState: null }, { locationState: '' }] });
    expect(calls[0].skip).toBe(40);
  });
});

describe('canSeeMembers', () => {
  it('lets verified, premium, and admin viewers see members, and nobody else', () => {
    expect(canSeeMembers(null)).toBe(false);
    expect(canSeeMembers({ verifiedStatus: 'none' })).toBe(false);
    expect(canSeeMembers({ verifiedStatus: 'identity' })).toBe(true);
    expect(canSeeMembers({ verifiedStatus: 'none', premium: true })).toBe(true);
    expect(canSeeMembers({ verifiedStatus: 'none', premiumPlus: true })).toBe(true);
    expect(canSeeMembers({ verifiedStatus: 'none', siteAdmin: true })).toBe(true);
  });
});
