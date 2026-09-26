import { MembersMapRealtimeService, membersMapChange, type MembersMapSnapshot } from './members-map-realtime.service';

const member = (locationState: string | null, extra: Partial<MembersMapSnapshot> = {}): MembersMapSnapshot => ({
  usernameIsSet: true,
  bannedAt: null,
  isBot: false,
  locationState,
  ...extra,
});

describe('membersMapChange', () => {
  it('reports a join when someone first counts, with where they count', () => {
    expect(membersMapChange(member('VA', { usernameIsSet: false }), member('VA'))).toEqual({
      kind: 'joined',
      state: 'VA',
      previousState: null,
    });
  });

  it('reports a move between states, into and out of "no location"', () => {
    expect(membersMapChange(member('va'), member('TX'))).toEqual({ kind: 'moved', state: 'TX', previousState: 'VA' });
    expect(membersMapChange(member(null), member('TX'))).toEqual({ kind: 'moved', state: 'TX', previousState: null });
    expect(membersMapChange(member('TX'), member(''))).toEqual({ kind: 'moved', state: null, previousState: 'TX' });
  });

  it('reports a leave when someone stops counting, and nothing for no-ops or bots', () => {
    expect(membersMapChange(member('VA'), member('VA', { bannedAt: new Date() }))).toEqual({
      kind: 'left',
      state: null,
      previousState: 'VA',
    });
    expect(membersMapChange(member('VA'), member('va'))).toBeNull();
    expect(membersMapChange(member(null, { isBot: true }), member('VA', { isBot: true }))).toBeNull();
  });
});

describe('MembersMapRealtimeService.notifyChange', () => {
  it('drops the counts cache and emits the card only alongside the change', async () => {
    const realtime = { emitMembersMapChanged: jest.fn() };
    const redis = { del: jest.fn(async () => 1) };
    const prisma = {
      user: {
        findUnique: jest.fn(async () => ({
          id: 'u1', username: 'sam', name: 'Sam', premium: false, premiumPlus: false, isOrganization: false,
          accountKind: 'person', verifiedStatus: 'identity', avatarKey: null, avatarVideoKey: null,
          avatarVideoDurationMs: null, avatarUpdatedAt: null, bannedAt: null, isBot: false, orgMemberships: [],
        })),
      },
    };
    const service = new MembersMapRealtimeService(prisma as any, { r2: () => null } as any, redis as any, realtime as any);

    service.notifyChange('u1', member('VA', { usernameIsSet: false }), member('VA'));
    service.notifyChange('u1', member('VA'), member('VA'));
    await new Promise((r) => setTimeout(r, 0));

    expect(redis.del).toHaveBeenCalledTimes(1);
    expect(realtime.emitMembersMapChanged).toHaveBeenCalledTimes(1);
    const [change, user] = realtime.emitMembersMapChanged.mock.calls[0]!;
    expect(change).toEqual({ kind: 'joined', state: 'VA', previousState: null });
    expect(user).toMatchObject({ id: 'u1', username: 'sam' });
  });
});
