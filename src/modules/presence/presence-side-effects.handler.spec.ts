import { FOLLOW_ONLINE_MIN_OFFLINE_MS, PresenceSideEffectsHandler } from './presence-side-effects.handler';

function fakeRedis() {
  const store = new Map<string, string>();
  return {
    store,
    getString: jest.fn(async (k: string) => store.get(k) ?? null),
    setString: jest.fn(async (k: string, v: string, opts?: { onlyIfAbsent?: boolean }) => {
      if (opts?.onlyIfAbsent && store.has(k)) return false;
      store.set(k, v);
      return true;
    }),
    getJson: jest.fn(async (k: string) => (store.has(k) ? JSON.parse(store.get(k)!) : null)),
    setJson: jest.fn(async (k: string, v: unknown) => void store.set(k, JSON.stringify(v))),
    del: jest.fn(async (...keys: string[]) => keys.filter((k) => store.delete(k)).length),
  };
}

const card = (id: string) => ({
  id, username: id, name: id, premium: false, premiumPlus: false, isOrganization: false, accountKind: 'person',
  verifiedStatus: 'identity', avatarKey: null, avatarVideoKey: null, avatarVideoDurationMs: null,
  avatarUpdatedAt: null, bannedAt: null, isBot: false, orgMemberships: [],
});

function makeHandler(opts: {
  online: string[];
  follows: Array<[follower: string, following: string]>;
  lastOnlineAt?: Record<string, Date | null>;
  person?: Partial<{ isBot: boolean; accountKind: string; bannedAt: Date | null }>;
  optedOut?: string[];
  mutes?: Array<[muter: string, muted: string]>;
  blocks?: Array<[blocker: string, blocked: string]>;
}) {
  const redis = fakeRedis();
  const prisma = {
    user: {
      findUnique: jest.fn(async ({ where }: any) => ({
        usernameIsSet: true,
        bannedAt: null,
        isBot: false,
        accountKind: 'person',
        lastOnlineAt: opts.lastOnlineAt?.[where.id] ?? new Date(Date.now() - 2 * FOLLOW_ONLINE_MIN_OFFLINE_MS),
        ...opts.person,
      })),
      findMany: jest.fn(async ({ where }: any) => (where.id.in as string[]).map(card)),
    },
    follow: {
      findMany: jest.fn(async ({ where }: any) =>
        opts.follows
          .filter(([f, g]) => g === where.followingId && (where.followerId.in as string[]).includes(f))
          .map(([followerId]) => ({ followerId })),
      ),
    },
    notificationPreferences: {
      findMany: jest.fn(async ({ where }: any) =>
        (opts.optedOut ?? []).filter((id) => (where.userId.in as string[]).includes(id)).map((userId) => ({ userId })),
      ),
    },
    userMute: {
      findMany: jest.fn(async ({ where }: any) =>
        (opts.mutes ?? []).filter(([, muted]) => muted === where.mutedId).map(([muterId]) => ({ muterId })),
      ),
    },
    userBlock: {
      findMany: jest.fn(async () => (opts.blocks ?? []).map(([blockerId, blockedId]) => ({ blockerId, blockedId }))),
    },
  };
  const realtime = { emitFollowedOnline: jest.fn() };
  const sideEffects = { dispatch: jest.fn() };
  const handler = new PresenceSideEffectsHandler(
    prisma as any,
    { r2: () => null } as any,
    redis as any,
    { onlineUserIds: jest.fn(async () => opts.online) } as any,
    realtime as any,
    { register: jest.fn() } as any,
    sideEffects as any,
  );
  return { handler, realtime, sideEffects, redis };
}

const pinged = (realtime: { emitFollowedOnline: jest.Mock }) =>
  realtime.emitFollowedOnline.mock.calls.map(([viewer, p]: [string, { users: Array<{ id: string }>; total: number }]) => [
    viewer,
    p.users.map((u) => u.id),
    p.total,
  ]);

describe('PresenceSideEffectsHandler follow-online pings', () => {
  it('pings online followers right away when someone was really away', async () => {
    const { handler, realtime } = makeHandler({ online: ['sam', 'me', 'offline-fan'], follows: [['me', 'sam'], ['nobody', 'sam']] });
    await handler.onFollowedOnline({ userId: 'sam' });
    expect(pinged(realtime)).toEqual([['me', ['sam'], 1]]);
  });

  it('ignores reconnect blips, bots, and pages', async () => {
    const blip = makeHandler({ online: ['sam', 'me'], follows: [['me', 'sam']], lastOnlineAt: { sam: new Date(Date.now() - 60_000) } });
    await blip.handler.onFollowedOnline({ userId: 'sam' });
    expect(blip.realtime.emitFollowedOnline).not.toHaveBeenCalled();

    const page = makeHandler({ online: ['shop', 'me'], follows: [['me', 'shop']], person: { accountKind: 'page' } });
    await page.handler.onFollowedOnline({ userId: 'shop' });
    expect(page.realtime.emitFollowedOnline).not.toHaveBeenCalled();
  });

  it('skips viewers who opted out, muted, or blocked either way', async () => {
    const { handler, realtime } = makeHandler({
      online: ['sam', 'a', 'b', 'c', 'd', 'e'],
      follows: [['a', 'sam'], ['b', 'sam'], ['c', 'sam'], ['d', 'sam'], ['e', 'sam']],
      optedOut: ['a'],
      mutes: [['b', 'sam']],
      blocks: [['c', 'sam'], ['sam', 'd']],
    });
    await handler.onFollowedOnline({ userId: 'sam' });
    expect(pinged(realtime)).toEqual([['e', ['sam'], 1]]);
  });

  it('tells a viewer about the same person at most once per window', async () => {
    const { handler, realtime } = makeHandler({ online: ['sam', 'me'], follows: [['me', 'sam']] });
    await handler.onFollowedOnline({ userId: 'sam' });
    await handler.onFollowedOnline({ userId: 'sam' });
    expect(realtime.emitFollowedOnline).toHaveBeenCalledTimes(1);
  });

  it('batches arrivals during the quiet window into one flushed ping', async () => {
    const { handler, realtime, sideEffects } = makeHandler({
      online: ['sam', 'dan', 'tom', 'me'],
      follows: [['me', 'sam'], ['me', 'dan'], ['me', 'tom']],
    });
    await handler.onFollowedOnline({ userId: 'sam' });
    await handler.onFollowedOnline({ userId: 'dan' });
    await handler.onFollowedOnline({ userId: 'tom' });

    expect(pinged(realtime)).toEqual([['me', ['sam'], 1]]);
    expect(sideEffects.dispatch).toHaveBeenCalledWith(
      'presence.followed-online.flush',
      { viewerUserId: 'me' },
      expect.objectContaining({ jobId: expect.stringMatching(/^follow-online-flush:me:/), delay: expect.any(Number) }),
    );
    // Both waiting arrivals share one flush job (same window → same jobId).
    const jobIds = new Set(sideEffects.dispatch.mock.calls.map(([, , o]: any[]) => o.jobId));
    expect(jobIds.size).toBe(1);

    await handler.onFlush({ viewerUserId: 'me' });
    expect(pinged(realtime)).toEqual([
      ['me', ['sam'], 1],
      ['me', ['dan', 'tom'], 2],
    ]);
  });
});
