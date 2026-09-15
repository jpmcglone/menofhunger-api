import { CacheService } from '../redis/cache.service';
import { LinkMetadataService } from './link-metadata.service';
const canonical = 'https://open.spotify.com/track/4cOdK2wGLETKBW3PvgPWqT';
const share = 'https://spotify.link/example';
function setup() {
  const values = new Map<string, unknown>();
  const redis = {
    getJson: jest.fn(async (key: string) => values.get(key) ?? null),
    setJson: jest.fn(async (key: string, value: unknown, _options: unknown) => {
      values.set(key, value);
    }),
    withLock: jest.fn(
      async (_key: string, _options: unknown, fn: () => Promise<unknown>) =>
        fn(),
    ),
  };
  const prisma = {
    linkMetadata: {
      findUnique: jest.fn(async () => null),
      upsert: jest.fn(async (args) => ({
        ...args.create,
        socialPost: null,
        videoEmbed: null,
      })),
    },
  };
  const service = new LinkMetadataService(
    prisma as any,
    new CacheService(redis as any),
    { frontendBaseUrl: () => '' } as any,
  );
  return { service, prisma, redis };
}
describe('Spotify metadata contract and cache', () => {
  afterEach(() => jest.restoreAllMocks());
  it('returns the canonical URL to both clients and reuses cached share resolution', async () => {
    const { service, prisma } = setup();
    const fetcher = jest
      .spyOn(global, 'fetch')
      .mockImplementation(async (input) =>
        String(input) === share
          ? new Response(null, {
              status: 302,
              headers: { location: canonical },
            })
          : Response.json({
              title: 'A song',
              thumbnail_url: 'https://i.scdn.co/image/abc',
            }),
      );
    const meta = await service.getMetadata(share);
    expect(meta).toMatchObject({
      url: canonical,
      title: 'A song',
      siteName: 'Spotify',
      videoEmbed: null,
    });
    expect(await service.getMetadata(share)).toEqual(meta);
    expect(fetcher).toHaveBeenCalledTimes(2);
    expect(prisma.linkMetadata.upsert).toHaveBeenCalledTimes(1);
    expect(prisma.linkMetadata.upsert.mock.calls[0][0].where.url).toBe(
      canonical,
    );
  });
  it('retains the playable URL when Spotify metadata is temporarily unavailable', async () => {
    const { service } = setup();
    jest.spyOn(global, 'fetch').mockImplementation(async (input) =>
      String(input) === share
        ? new Response(null, {
            status: 302,
            headers: { location: canonical },
          })
        : new Response(null, { status: 503 }),
    );
    expect(await service.getMetadata(share)).toMatchObject({
      url: canonical,
      siteName: 'Spotify',
    });
  });
  it('briefly caches failed redirects instead of repeatedly requesting them', async () => {
    const { service, redis } = setup();
    const fetcher = jest
      .spyOn(global, 'fetch')
      .mockResolvedValue(new Response(null, { status: 404 }));
    expect(await service.getMetadata(share)).toBeNull();
    expect(await service.getMetadata(share)).toBeNull();
    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(redis.setJson).toHaveBeenLastCalledWith(
      expect.any(String),
      { meta: null },
      { ttlSeconds: 60 },
    );
  });
});
