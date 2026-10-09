import { LinkMetadataService } from './link-metadata.service';

function setup() {
  const cache = { getJson: jest.fn() };
  const prisma = { linkMetadata: { findUnique: jest.fn() } };
  const service = new LinkMetadataService(prisma as any, cache as any, { frontendBaseUrl: () => 'https://menofhunger.com' } as any);
  return { service, cache, prisma };
}

describe('Men of Hunger feature previews', () => {
  afterEach(() => jest.restoreAllMocks());

  it.each([
    ['/b', 'Boards', 'boards-v1.png'],
    ['/a', 'Articles', 'articles-v1.png'],
    ['/articles', 'Articles', 'articles-v1.png'],
    ['/fitness', 'Fitness', 'fitness-v1.png'],
    ['/b/thread/c/comment', 'Board comment', 'boards-v1.png'],
    ['/fitness/activities/private-id', 'Fitness activity', 'fitness-v1.png'],
    ['/daily/quote', 'Quote of the day', 'daily-v1.png'],
    ['/spaces', 'Spaces', 'spaces-v1.png'],
    ['/radio', 'Spaces', 'spaces-v1.png'],
    ['/map?state=VA', 'VA · Member map', 'map.png?state=VA'],
  ])('returns safe artwork for %s without scraping or cached login metadata', async (path, title, image) => {
    const { service, cache, prisma } = setup();
    const fetcher = jest.spyOn(global, 'fetch');
    const metadata = await service.getMetadata(`https://menofhunger.com${path}`);
    expect(metadata?.title).toBe(title);
    expect(metadata?.imageUrl).toBe(`https://menofhunger.com/${image.startsWith('map') ? 'og' : 'images/features'}/${image}`);
    expect(metadata?.description).toBeTruthy();
    expect(fetcher).not.toHaveBeenCalled();
    expect(cache.getJson).not.toHaveBeenCalled();
    expect(prisma.linkMetadata.findUnique).not.toHaveBeenCalled();
  });

  it.each([
    'https://menofhunger.com',
    'https://menofhunger.com/',
    'https://menofhunger.com/?utm_source=invite',
    'https://www.menofhunger.com/',
  ])('uses the homepage invitation for %s without scraping or stale cached metadata', async (url) => {
    const { service, cache, prisma } = setup();
    const fetcher = jest.spyOn(global, 'fetch');
    const metadata = await service.getMetadata(url);
    expect(metadata?.title).toBe('Men of Hunger — Join men who show up.');
    expect(metadata?.description).toBe('Join a trusted community for men who want real conversation, not more noise. Bring your friends, find your people, and show up together.');
    expect(metadata?.imageUrl).toBe('https://menofhunger.com/images/social/home-v1.png');
    expect(fetcher).not.toHaveBeenCalled();
    expect(cache.getJson).not.toHaveBeenCalled();
    expect(prisma.linkMetadata.findUnique).not.toHaveBeenCalled();
  });

  it('keeps unknown routes and profiles free of unrelated feature covers', async () => {
    const { service } = setup();
    const metadata = await service.getMetadata('https://menofhunger.com/u/john');
    expect(metadata?.title).toBe('@john');
    expect(metadata?.imageUrl).toBeNull();
  });
});
