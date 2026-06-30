import { PresenceController } from './presence.controller';
import { VerifiedGuard } from '../auth/verified.guard';

/**
 * Lightweight tests for the Marv "always online" injection in /presence/online and
 * /presence/online-page. We mock every collaborator so the test boots in milliseconds
 * and we can assert exactly when Marv is prepended (or not).
 *
 * The full controller has a large surface (cursor pagination, "recently online"
 * privacy gating, etc.) — those flows are exercised elsewhere. Here we only care
 * about the synthetic-bot-row behaviour added by the
 * `marv-not-configured-and-always-online` plan.
 */

type MarvBotConfig = {
  enabled: boolean;
  userId: string | null;
  username: string;
  displayName: string;
  bio: string;
  phone: string;
};

function makeController(opts?: {
  marvEnabled?: boolean;
  marvUserId?: string | null;
  onlineUserIds?: string[];
}) {
  const onlineIds = opts?.onlineUserIds ?? ['user-a', 'user-b'];

  const presenceRedis: any = {
    onlineUserIds: jest.fn(async () => [...onlineIds]),
    lastConnectAtMsByUserId: jest.fn(async (ids: string[]) => {
      const map = new Map<string, number>();
      ids.forEach((id, i) => map.set(id, 1000 + i));
      return map;
    }),
    idleByUserIds: jest.fn(async (ids: string[]) => new Map(ids.map((id) => [id, false]))),
  };

  const presence: any = {
    getActiveStatuses: jest.fn(async () => []),
    getClientsForUser: jest.fn((_userId: string) => [] as string[]),
  };
  const realtime: any = {};
  const follows: any = {
    getFollowListUsersByIds: jest.fn(async ({ userIds }: { userIds: string[] }) =>
      userIds.map((id) => ({ id, username: id, name: id, premium: false })),
    ),
  };
  const prisma: any = {
    user: { count: jest.fn(async () => 0) },
  };
  const redis: any = {
    getJson: jest.fn(async () => null),
    setJson: jest.fn(async () => undefined),
  };
  const appConfig: any = {
    marvBot: jest.fn(
      (): MarvBotConfig => ({
        enabled: opts?.marvEnabled ?? true,
        userId: 'marv-id',
        username: 'marv',
        displayName: 'Marv',
        bio: '',
        phone: '',
      }),
    ),
  };
  const marvIdentity: any = {
    getMarvUserId: jest.fn(async () =>
      opts?.marvUserId === undefined ? 'marv-id' : opts.marvUserId,
    ),
  };

  const controller = new PresenceController(
    presenceRedis,
    presence,
    realtime,
    follows,
    prisma,
    redis,
    appConfig,
    marvIdentity,
  );

  return { controller, follows, redis, marvIdentity, appConfig, presenceRedis, prisma };
}

describe('PresenceController — Marv pin injection', () => {
  describe('GET /presence/online', () => {
    it('prepends Marv with isBot:true and bumps totalOnline when enabled', async () => {
      const m = makeController();
      const res: any = await m.controller.online(undefined, undefined);
      const data: any[] = res.data;
      expect(data[0]).toEqual(
        expect.objectContaining({ id: 'marv-id', isBot: true, idle: false }),
      );
      // Two real users + 1 Marv = 3.
      expect(res.pagination.totalOnline).toBe(3);
    });

    it('omits Marv entirely when MARV_ENABLED=false', async () => {
      const m = makeController({ marvEnabled: false });
      const res: any = await m.controller.online(undefined, undefined);
      const data: any[] = res.data;
      expect(data.find((u) => u.id === 'marv-id')).toBeUndefined();
      expect(res.pagination.totalOnline).toBe(2);
      // Identity service should never even be consulted when the global flag is off.
      expect(m.marvIdentity.getMarvUserId).not.toHaveBeenCalled();
    });

    it('omits Marv when the bot user has not been seeded yet', async () => {
      const m = makeController({ marvUserId: null });
      const res: any = await m.controller.online(undefined, undefined);
      const data: any[] = res.data;
      expect(data.find((u) => u.id === 'marv-id')).toBeUndefined();
      expect(res.pagination.totalOnline).toBe(2);
    });

    it('does not list Marv as the viewer when Marv himself somehow makes the request', async () => {
      const m = makeController();
      const res: any = await m.controller.online('marv-id', undefined);
      const data: any[] = res.data;
      expect(data.find((u) => u.id === 'marv-id' && u.isBot)).toBeUndefined();
    });
  });

  describe('GET /presence/online-page', () => {
    it('prepends Marv on the combined online-page response and bumps totalOnline', async () => {
      const m = makeController();
      const res: any = await m.controller.onlinePage(undefined, {});
      expect(res.data.online[0]).toEqual(
        expect.objectContaining({ id: 'marv-id', isBot: true }),
      );
      expect(res.pagination.totalOnline).toBe(3);
    });

    it('skips Marv on online-page when disabled', async () => {
      const m = makeController({ marvEnabled: false });
      const res: any = await m.controller.onlinePage(undefined, {});
      expect(res.data.online.find((u: any) => u.id === 'marv-id')).toBeUndefined();
      expect(res.pagination.totalOnline).toBe(2);
    });
  });
});

describe('PresenceController — setting your own status is verified-gated', () => {
  // Reads guard metadata applied by @UseGuards so the verified-only contract is
  // encoded as a test (guards aren't exercised by calling handlers directly).
  function guardsFor(handler: (...args: never[]) => unknown): unknown[] {
    return (Reflect.getMetadata('__guards__', handler) as unknown[] | undefined) ?? [];
  }

  it('PUT /presence/status (setStatus) requires VerifiedGuard', () => {
    expect(guardsFor(PresenceController.prototype.setStatus)).toContain(VerifiedGuard);
  });

  it('DELETE /presence/status (clearStatus) requires VerifiedGuard', () => {
    expect(guardsFor(PresenceController.prototype.clearStatus)).toContain(VerifiedGuard);
  });

  it('GET /presence/statuses (statuses) does NOT require VerifiedGuard — everyone can read statuses', () => {
    expect(guardsFor(PresenceController.prototype.statuses)).not.toContain(VerifiedGuard);
  });
});

describe('PresenceController — online() output shape and per-call invariants', () => {
  it('produces one row per real online user, in connect-time-asc order, with idle/status/lastConnect populated', async () => {
    const m = makeController({
      marvEnabled: false,
      onlineUserIds: ['user-a', 'user-b', 'user-c'],
    });
    // Make user-c the longest-online (smallest lastConnectAtMs), user-a newest.
    m.presenceRedis.lastConnectAtMsByUserId.mockImplementation(async (ids: string[]) => {
      const offsets: Record<string, number> = { 'user-a': 3000, 'user-b': 2000, 'user-c': 1000 };
      return new Map(ids.map((id) => [id, offsets[id] ?? 9999]));
    });
    m.presenceRedis.idleByUserIds.mockImplementation(
      async (ids: string[]) => new Map(ids.map((id) => [id, id === 'user-b'])),
    );

    const res: any = await m.controller.online(undefined, undefined);

    expect(res.data.map((u: any) => u.id)).toEqual(['user-c', 'user-b', 'user-a']);
    expect(res.pagination.totalOnline).toBe(3);
    expect(res.data[0]).toEqual(
      expect.objectContaining({
        id: 'user-c',
        idle: false,
        status: null,
        lastConnectAt: 1000,
      }),
    );
    expect(res.data[1]).toEqual(expect.objectContaining({ id: 'user-b', idle: true }));
  });

  it('calls each downstream collaborator exactly once per online() invocation', async () => {
    const m = makeController({ marvEnabled: false });
    await m.controller.online(undefined, undefined);

    expect(m.presenceRedis.onlineUserIds).toHaveBeenCalledTimes(1);
    expect(m.presenceRedis.lastConnectAtMsByUserId).toHaveBeenCalledTimes(1);
    expect(m.follows.getFollowListUsersByIds).toHaveBeenCalledTimes(1);
    expect(m.presenceRedis.idleByUserIds).toHaveBeenCalledTimes(1);
  });

  it('reports recentlyOnlineCount from a user count excluding everyone currently online', async () => {
    const m = makeController({ marvEnabled: false, onlineUserIds: ['user-a', 'user-b'] });
    m.prisma.user.count.mockResolvedValueOnce(5);

    const res: any = await m.controller.online(undefined, undefined);

    expect(res.pagination.recentlyOnlineCount).toBe(5);
    expect(m.prisma.user.count).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          usernameIsSet: true,
          bannedAt: null,
          id: { notIn: ['user-a', 'user-b'] },
        }),
      }),
    );
  });

  it('omits the id exclusion filter when nobody is currently online', async () => {
    const m = makeController({ marvEnabled: false, onlineUserIds: [] });

    await m.controller.online(undefined, undefined);

    const call = m.prisma.user.count.mock.calls[0]?.[0];
    expect(call.where.id).toBeUndefined();
  });

  it('runs lastConnectAt/follows/idle/statuses concurrently after onlineUserIds resolves', async () => {
    const m = makeController({ marvEnabled: false });
    let active = 0;
    let maxActive = 0;
    const slow = <T,>(value: T, ms = 25) =>
      new Promise<T>((resolve) => {
        active += 1;
        if (active > maxActive) maxActive = active;
        setTimeout(() => {
          active -= 1;
          resolve(value);
        }, ms);
      });

    m.presenceRedis.lastConnectAtMsByUserId.mockImplementation(async (ids: string[]) => {
      return slow(new Map(ids.map((id, i) => [id, 1000 + i])));
    });
    m.follows.getFollowListUsersByIds.mockImplementation(async ({ userIds }: { userIds: string[] }) =>
      slow(userIds.map((id) => ({ id, username: id, name: id, premium: false }))),
    );
    m.presenceRedis.idleByUserIds.mockImplementation(async (ids: string[]) =>
      slow(new Map(ids.map((id) => [id, false]))),
    );

    await m.controller.online(undefined, undefined);

    // The four post-onlineUserIds awaits run in parallel, so at least 2
    // operations should have been in-flight at the same time.
    expect(maxActive).toBeGreaterThanOrEqual(2);
  });
});
