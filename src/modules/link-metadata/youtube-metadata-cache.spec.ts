import { CacheService } from '../redis/cache.service';
import { RedisKeys } from '../redis/redis-keys';
import { LinkMetadataService } from './link-metadata.service';
import { LinkMetadataController } from './link-metadata.controller';

const url = 'https://www.youtube.com/watch?v=yVm8vDoMzYs';
function setup() {
  const values = new Map<string, unknown>([[RedisKeys.linkMeta(url), { meta: null }]]);
  const redis = {
    getJson: jest.fn(async (key: string) => values.get(key) ?? null),
    setJson: jest.fn(async (key: string, value: unknown, _options: unknown) => { values.set(key, value); }),
    withLock: jest.fn(async (_key: string, _options: unknown, fn: () => Promise<unknown>) => fn()),
  };
  const prisma = { linkMetadata: {
    findUnique: jest.fn(async () => ({ url, title: 'YouTube video', description: null, siteName: 'YouTube',
      imageUrl: null, socialPost: null, videoEmbed: null, updatedAt: new Date() })),
    upsert: jest.fn(async (args) => ({ ...args.create, socialPost: null, videoEmbed: null })),
  } };
  const service = new LinkMetadataService(prisma as any, new CacheService(redis as any), { frontendBaseUrl: () => '' } as any);
  return { service, prisma, redis, values };
}

describe('YouTube metadata cache recovery', () => {
  afterEach(() => jest.restoreAllMocks());

  it('replaces old null Redis and generic DB records, then reuses the enriched result', async () => {
    const { service, prisma } = setup();
    const fetcher = jest.spyOn(global, 'fetch').mockResolvedValue(new Response(JSON.stringify({
      title: 'They CANNOT be real people..', author_name: 'Asmongold TV  ', type: 'video',
    })));
    const meta = await service.getMetadata(url);
    expect(meta?.title).toBe('They CANNOT be real people..');
    expect(meta?.siteName).toBe('YouTube · Asmongold TV');
    expect(await service.getMetadata(url)).toEqual(meta);
    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(prisma.linkMetadata.upsert).toHaveBeenCalledTimes(1);
  });

  it('caches failures for one minute instead of overwriting the TTL with six hours', async () => {
    const { service, redis, prisma } = setup();
    jest.spyOn(global, 'fetch').mockResolvedValue(new Response('', { status: 404 }));
    expect(await service.getMetadata(url)).toBeNull();
    expect(redis.setJson).toHaveBeenLastCalledWith(expect.any(String), { meta: null }, { ttlSeconds: 60 });
    expect(prisma.linkMetadata.upsert).not.toHaveBeenCalled();
  });

  it('does not HTTP-cache a temporary failure', async () => {
    const res = { setHeader: jest.fn() };
    const controller = new LinkMetadataController({ getMetadata: async () => null } as any);
    expect(await controller.get({ url, v: 3 }, res as any)).toEqual({ data: null });
    expect(res.setHeader).toHaveBeenCalledWith('Cache-Control', 'no-store');
  });
});
