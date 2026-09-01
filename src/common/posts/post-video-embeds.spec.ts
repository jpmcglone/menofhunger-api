import { loadPostVideoEmbeds, previewLinkForPostBody } from './post-video-embeds';

const RUMBLE_PAGE = 'https://rumble.com/v6abc12-morning-run.html';
const RUMBLE_EMBED = {
  platform: 'rumble',
  embedUrl: 'https://rumble.com/embed/v6abc12/',
  thumbnailUrl: 'https://1a-1791.com/thumb.jpg',
  width: 1080,
  height: 1920,
  sizedBy: 'embedjs',
};

function fakePrisma(rows: Array<{ url: string; videoEmbed: unknown }>) {
  const calls: Array<{ where: { url: { in: string[] } } }> = [];
  return {
    calls,
    linkMetadata: {
      findMany: async (args: { where: { url: { in: string[] } }; select: { url: true; videoEmbed: true } }) => {
        calls.push(args);
        return rows.filter((r) => args.where.url.in.includes(r.url)) as Array<{ url: string; videoEmbed: never }>;
      },
    },
  };
}

describe('previewLinkForPostBody', () => {
  it('returns the last external link, normalized, ignoring trailing punctuation', () => {
    expect(previewLinkForPostBody(`first https://example.com/a then ${RUMBLE_PAGE}.`)).toBe(RUMBLE_PAGE);
  });

  it('skips MoH links the same way the web preview does', () => {
    expect(previewLinkForPostBody(`${RUMBLE_PAGE} https://menofhunger.com/p/abc`)).toBe(RUMBLE_PAGE);
    expect(previewLinkForPostBody('https://www.menofhunger.com/u/john')).toBeNull();
  });

  it('returns null for bodies without links', () => {
    expect(previewLinkForPostBody('no links here')).toBeNull();
    expect(previewLinkForPostBody(null)).toBeNull();
  });
});

describe('loadPostVideoEmbeds', () => {
  it('maps cached rumble embeds onto posts by their preview link in one query', async () => {
    const prisma = fakePrisma([{ url: RUMBLE_PAGE, videoEmbed: RUMBLE_EMBED }]);
    const out = await loadPostVideoEmbeds(prisma, [
      { id: 'p1', body: `watch ${RUMBLE_PAGE}` },
      { id: 'p2', body: `also ${RUMBLE_PAGE}` },
      { id: 'p3', body: 'https://example.com/no-row' },
      { id: 'p4', body: 'plain text' },
    ]);

    expect(prisma.calls).toHaveLength(1);
    expect(prisma.calls[0]!.where.url.in).toEqual([RUMBLE_PAGE, 'https://example.com/no-row']);
    expect(out.get('p1')).toEqual({
      url: RUMBLE_PAGE,
      platform: 'rumble',
      embedUrl: RUMBLE_EMBED.embedUrl,
      thumbnailUrl: RUMBLE_EMBED.thumbnailUrl,
      width: 1080,
      height: 1920,
    });
    expect(out.get('p2')).toEqual(out.get('p1'));
    expect(out.has('p3')).toBe(false);
    expect(out.has('p4')).toBe(false);
  });

  it('skips rows without a usable videoEmbed and never queries with no links', async () => {
    const prisma = fakePrisma([
      { url: 'https://example.com/article', videoEmbed: null },
      { url: 'https://example.com/bad', videoEmbed: { platform: 'rumble', embedUrl: '', width: 0, height: 0 } },
    ]);
    const out = await loadPostVideoEmbeds(prisma, [
      { id: 'a', body: 'https://example.com/article' },
      { id: 'b', body: 'https://example.com/bad' },
    ]);
    expect(out.size).toBe(0);

    const idle = fakePrisma([]);
    expect((await loadPostVideoEmbeds(idle, [{ id: 'c', body: 'nothing' }])).size).toBe(0);
    expect(idle.calls).toHaveLength(0);
  });

  it('degrades to an empty map when the lookup throws', async () => {
    const prisma = {
      linkMetadata: {
        findMany: async () => {
          throw new Error('db down');
        },
      },
    };
    const out = await loadPostVideoEmbeds(prisma, [{ id: 'p1', body: RUMBLE_PAGE }]);
    expect(out.size).toBe(0);
  });
});
