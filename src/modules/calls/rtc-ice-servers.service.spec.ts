import {
  parseCloudflareIceServers,
  RtcIceServersService,
  withoutBrowserBlockedIceUrls,
} from './rtc-ice-servers.service';

const CF_BODY = {
  iceServers: [
    {
      urls: [
        'stun:stun.cloudflare.com:3478',
        'stun:stun.cloudflare.com:53',
        'turn:turn.cloudflare.com:3478?transport=udp',
        'turn:turn.cloudflare.com:53?transport=udp',
        'turns:turn.cloudflare.com:5349?transport=tcp',
      ],
      username: 'u1',
      credential: 'c1',
    },
  ],
};

const STUN_FALLBACK = [{ urls: ['stun:stun.example.com'] }];

function makeService(opts: { turn?: { keyId: string; apiToken: string } | null } = {}) {
  const appConfig = {
    cloudflareTurn: jest.fn(() => opts.turn ?? null),
    rtcIceServers: jest.fn(() => STUN_FALLBACK),
  };
  return {
    svc: new RtcIceServersService(appConfig as any),
    appConfig,
  };
}

describe('withoutBrowserBlockedIceUrls', () => {
  it('drops port 53 STUN/TURN URLs and keeps 3478/5349', () => {
    expect(
      withoutBrowserBlockedIceUrls([
        'stun:stun.cloudflare.com:3478',
        'stun:stun.cloudflare.com:53',
        'turn:turn.cloudflare.com:3478?transport=udp',
        'turn:turn.cloudflare.com:53?transport=udp',
      ]),
    ).toEqual(['stun:stun.cloudflare.com:3478', 'turn:turn.cloudflare.com:3478?transport=udp']);
  });
});

describe('parseCloudflareIceServers', () => {
  it('keeps username/credential and strips port 53', () => {
    expect(parseCloudflareIceServers(CF_BODY)).toEqual([
      {
        urls: [
          'stun:stun.cloudflare.com:3478',
          'turn:turn.cloudflare.com:3478?transport=udp',
          'turns:turn.cloudflare.com:5349?transport=tcp',
        ],
        username: 'u1',
        credential: 'c1',
      },
    ]);
  });

  it('returns null for empty or malformed payloads', () => {
    expect(parseCloudflareIceServers(null)).toBeNull();
    expect(parseCloudflareIceServers({ iceServers: [] })).toBeNull();
    expect(parseCloudflareIceServers({ iceServers: [{ urls: ['stun:stun.cloudflare.com:53'] }] })).toBeNull();
  });
});

describe('RtcIceServersService', () => {
  const originalFetch = global.fetch;

  afterEach(() => {
    global.fetch = originalFetch;
    jest.restoreAllMocks();
  });

  it('uses static STUN when Cloudflare TURN is unset', async () => {
    const { svc, appConfig } = makeService();
    await expect(svc.resolve()).resolves.toEqual(STUN_FALLBACK);
    expect(appConfig.rtcIceServers).toHaveBeenCalled();
  });

  it('returns minted Cloudflare ICE servers when the key is set', async () => {
    const { svc } = makeService({ turn: { keyId: 'key', apiToken: 'tok' } });
    global.fetch = jest.fn(async () => ({
      ok: true,
      json: async () => CF_BODY,
    })) as unknown as typeof fetch;

    const servers = await svc.resolve();
    expect(servers[0]?.username).toBe('u1');
    expect(servers[0]?.urls).toContain('turn:turn.cloudflare.com:3478?transport=udp');
    expect(servers[0]?.urls.some((u) => /:53(?:\?|$)/.test(u))).toBe(false);
    expect(global.fetch).toHaveBeenCalledWith(
      'https://rtc.live.cloudflare.com/v1/turn/keys/key/credentials/generate-ice-servers',
      expect.objectContaining({ method: 'POST' }),
    );
  });

  it('falls back to static STUN when minting fails', async () => {
    const { svc, appConfig } = makeService({ turn: { keyId: 'key', apiToken: 'tok' } });
    global.fetch = jest.fn(async () => ({ ok: false, status: 401 })) as unknown as typeof fetch;
    await expect(svc.resolve()).resolves.toEqual(STUN_FALLBACK);
    expect(appConfig.rtcIceServers).toHaveBeenCalled();
  });

  it('reuses a successful mint within the process cache', async () => {
    const { svc } = makeService({ turn: { keyId: 'key', apiToken: 'tok' } });
    global.fetch = jest.fn(async () => ({
      ok: true,
      json: async () => CF_BODY,
    })) as unknown as typeof fetch;
    await svc.resolve();
    await svc.resolve();
    expect(global.fetch).toHaveBeenCalledTimes(1);
  });
});
