import { PresenceController } from './presence.controller';

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
  };
  const realtime: any = {};
  const follows: any = {
    getFollowListUsersByIds: jest.fn(async ({ userIds }: { userIds: string[] }) =>
      userIds.map((id) => ({ id, username: id, name: id, premium: false })),
    ),
  };
  const prisma: any = {};
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

  return { controller, follows, redis, marvIdentity, appConfig, presenceRedis };
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
