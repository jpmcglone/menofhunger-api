import { PresenceRedisStateService } from './presence-redis-state.service';

function makeService(overrides?: { lastConnectAtMsByUserId?: (ids: string[]) => Promise<Map<string, number | null>> }) {
  const redis = {
    duplicate: jest.fn(() => ({ subscribe: jest.fn(), on: jest.fn(), quit: jest.fn(), disconnect: jest.fn() })),
    raw: jest.fn(() => ({ pipeline: jest.fn(() => ({ zscore: jest.fn(), exec: jest.fn(async () => []) })) })),
    setJson: jest.fn(),
    del: jest.fn(),
  } as any;
  const appConfig = { presenceIdleDisconnectMinutes: jest.fn(() => 10) } as any;
  const svc = new PresenceRedisStateService(redis, appConfig);
  if (overrides?.lastConnectAtMsByUserId) {
    (svc as any).lastConnectAtMsByUserId = overrides.lastConnectAtMsByUserId;
  }
  return { svc };
}

describe('PresenceRedisStateService.onlineByUserIds', () => {
  it('marks users online when lastConnectAt exists', async () => {
    const { svc } = makeService({
      lastConnectAtMsByUserId: async (ids) => {
        const m = new Map<string, number | null>();
        for (const id of ids) m.set(id, id === 'u1' ? 123 : null);
        return m;
      },
    });

    const res = await svc.onlineByUserIds(['u1', 'u2']);
    expect(res.get('u1')).toBe(true);
    expect(res.get('u2')).toBe(false);
  });
});

