import { MarvinThreadContextService } from './marvin-thread-context.service';

/**
 * MarvinThreadContextService collects the conversation BOTH above (ancestors) and below
 * (descendant subtree) a focal post. The CTE id-resolution is mocked; we assert that:
 *  1. ancestors come back root-most → parent, descendants in the CTE-provided order,
 *  2. the focal post is returned separately,
 *  3. descendants are capped at the limit while `totalDescendants` reflects the full set,
 *  4. Marv-authored posts are flagged.
 */

type RawRow = { id: string; depth: number };

function makeService(opts: {
  ancestorRows: RawRow[];
  descendantRows: RawRow[];
  postRows: Array<{
    id: string;
    parentId: string | null;
    rootId: string | null;
    body: string;
    createdAt: Date;
    editedAt?: Date | null;
    checkinPrompt: string | null;
    userId: string;
    username: string | null;
    name: string | null;
  }>;
  marvUserId?: string | null;
}) {
  // First $queryRawUnsafe call resolves ancestors, second resolves descendants.
  let rawCall = 0;
  const queryRawUnsafe = jest.fn(async () => {
    rawCall += 1;
    return rawCall === 1 ? opts.ancestorRows : opts.descendantRows;
  });

  const findMany = jest.fn(async () =>
    opts.postRows.map((p) => ({
      id: p.id,
      parentId: p.parentId,
      rootId: p.rootId,
      body: p.body,
      createdAt: p.createdAt,
      editedAt: p.editedAt ?? null,
      checkinPrompt: p.checkinPrompt,
      userId: p.userId,
      user: { username: p.username, name: p.name },
      media: [],
      poll: null,
    })),
  );

  const prisma: any = {
    $queryRawUnsafe: queryRawUnsafe,
    post: { findMany },
  };
  const identity: any = {
    getMarvUserId: jest.fn(async () => opts.marvUserId ?? null),
  };

  return {
    service: new MarvinThreadContextService(prisma, identity),
    queryRawUnsafe,
    findMany,
  };
}

function post(
  id: string,
  parentId: string | null,
  rootId: string | null,
  userId = 'u-' + id,
  username = id,
) {
  return {
    id,
    parentId,
    rootId,
    body: `body ${id}`,
    createdAt: new Date('2026-01-01T00:00:00Z'),
    checkinPrompt: null,
    userId,
    username,
    name: id.toUpperCase(),
  };
}

describe('MarvinThreadContextService', () => {
  it('returns empty context for a blank focal id', async () => {
    const { service, queryRawUnsafe } = makeService({
      ancestorRows: [],
      descendantRows: [],
      postRows: [],
    });
    const result = await service.collect({ focalPostId: '   ' });
    expect(result).toEqual({
      focal: null,
      ancestors: [],
      descendants: [],
      totalDescendants: 0,
      rootId: null,
    });
    expect(queryRawUnsafe).not.toHaveBeenCalled();
  });

  it('assembles ancestors, focal, and descendants in order', async () => {
    const { service } = makeService({
      // CTE returns root-most → parent for ancestors.
      ancestorRows: [
        { id: 'root', depth: 2 },
        { id: 'parent', depth: 1 },
      ],
      descendantRows: [
        { id: 'child', depth: 1 },
        { id: 'grandchild', depth: 2 },
      ],
      postRows: [
        post('root', null, null),
        post('parent', 'root', 'root'),
        post('focal', 'parent', 'root'),
        post('child', 'focal', 'root'),
        post('grandchild', 'child', 'root'),
      ],
    });

    const result = await service.collect({ focalPostId: 'focal' });

    expect(result.focal?.id).toBe('focal');
    expect(result.ancestors.map((a) => a.id)).toEqual(['root', 'parent']);
    expect(result.descendants.map((d) => d.id)).toEqual(['child', 'grandchild']);
    expect(result.descendants.map((d) => d.depth)).toEqual([1, 2]);
    expect(result.totalDescendants).toBe(2);
    expect(result.rootId).toBe('root');
  });

  it('caps included descendants at the limit but keeps totalDescendants accurate', async () => {
    const descendantRows: RawRow[] = Array.from({ length: 5 }, (_, i) => ({
      id: `d${i}`,
      depth: 1,
    }));
    const postRows = [
      post('focal', null, null),
      ...descendantRows.map((r) => post(r.id, 'focal', 'focal')),
    ];
    const { service } = makeService({ ancestorRows: [], descendantRows, postRows });

    const result = await service.collect({ focalPostId: 'focal', descendantLimit: 3 });

    expect(result.descendants).toHaveLength(3);
    expect(result.totalDescendants).toBe(5);
  });

  it('flags Marv-authored posts', async () => {
    const { service } = makeService({
      ancestorRows: [],
      descendantRows: [{ id: 'marv-reply', depth: 1 }],
      postRows: [
        post('focal', null, null, 'u-focal', 'focal'),
        post('marv-reply', 'focal', 'focal', 'marv-user', 'marv'),
      ],
      marvUserId: 'marv-user',
    });

    const result = await service.collect({ focalPostId: 'focal' });
    expect(result.descendants[0]?.isMarv).toBe(true);
    expect(result.focal?.isMarv).toBe(false);
  });
});

// ── selectImageMedia: include EVERY image (multiple per post + throughout the thread) ──
function img(key: string) {
  return { kind: 'image', source: 'upload', r2Key: key, url: null };
}
function ctxPost(id: string, depth: number, media: Array<{ kind: string; source: string; r2Key: string | null; url: string | null }>) {
  return {
    id,
    parentId: null,
    rootId: 'root',
    depth,
    authorUserId: `u-${id}`,
    authorUsername: id,
    authorDisplayName: id,
    body: `body ${id}`,
    createdAt: new Date('2026-01-01T00:00:00Z'),
    editedAt: null,
    checkinPrompt: null,
    isMarv: false,
    media,
    poll: null,
  };
}

describe('MarvinThreadContextService.selectImageMedia', () => {
  const svc = new MarvinThreadContextService({} as any, {} as any);
  const opts = { visionEnabled: true, visionMaxImagesPerTurn: 8, publicBaseUrl: 'https://cdn.test' };

  it('includes all images from a single multi-image post (2 and 4)', () => {
    const two = svc.selectImageMedia(
      { focal: ctxPost('focal', 0, [img('a.jpg'), img('b.jpg')]), ancestors: [], descendants: [], totalDescendants: 0, rootId: 'root' } as any,
      opts,
    );
    expect(two.imageUrls).toEqual(['https://cdn.test/a.jpg', 'https://cdn.test/b.jpg']);

    const four = svc.selectImageMedia(
      { focal: ctxPost('focal', 0, [img('a.jpg'), img('b.jpg'), img('c.jpg'), img('d.jpg')]), ancestors: [], descendants: [], totalDescendants: 0, rootId: 'root' } as any,
      opts,
    );
    expect(four.imageUrls).toHaveLength(4);
    expect(four.totalImages).toBe(4);
  });

  it('includes images from throughout the thread in reading order (ancestors → focal → descendants)', () => {
    const result = svc.selectImageMedia(
      {
        ancestors: [ctxPost('root', -1, [img('root.jpg')])],
        focal: ctxPost('focal', 0, [img('focal1.jpg'), img('focal2.jpg')]),
        descendants: [ctxPost('child', 1, [img('child.jpg')])],
        totalDescendants: 1,
        rootId: 'root',
      } as any,
      opts,
    );
    expect(result.imageUrls).toEqual([
      'https://cdn.test/root.jpg',
      'https://cdn.test/focal1.jpg',
      'https://cdn.test/focal2.jpg',
      'https://cdn.test/child.jpg',
    ]);
    expect(result.totalImages).toBe(4);
  });

  it('caps at visionMaxImagesPerTurn but reports the true total', () => {
    const many = Array.from({ length: 12 }, (_, i) => img(`i${i}.jpg`));
    const result = svc.selectImageMedia(
      { focal: ctxPost('focal', 0, many), ancestors: [], descendants: [], totalDescendants: 0, rootId: 'root' } as any,
      { ...opts, visionMaxImagesPerTurn: 8 },
    );
    expect(result.imageUrls).toHaveLength(8);
    expect(result.totalImages).toBe(12);
  });

  it('guarantees focal-post images via proximity when image-heavy ancestors would starve them', () => {
    // 5 images total, cap 3. Top-down reading order would take the 4 ancestor images and drop
    // the focal one — proximity selection keeps focal + nearest neighbors instead.
    const result = svc.selectImageMedia(
      {
        ancestors: [
          ctxPost('a0', -3, [img('a0a.jpg'), img('a0b.jpg')]),
          ctxPost('a1', -2, [img('a1.jpg')]),
          ctxPost('parent', -1, [img('parent.jpg')]),
        ],
        focal: ctxPost('focal', 0, [img('focal.jpg')]),
        descendants: [],
        totalDescendants: 0,
        rootId: 'root',
      } as any,
      { ...opts, visionMaxImagesPerTurn: 3 },
    );
    expect(result.totalImages).toBe(5);
    expect(result.imageUrls).toContain('https://cdn.test/focal.jpg');
    // Kept set is the focal image + its two nearest neighbors, presented in reading order.
    expect(result.imageUrls).toEqual([
      'https://cdn.test/a1.jpg',
      'https://cdn.test/parent.jpg',
      'https://cdn.test/focal.jpg',
    ]);
  });

  it('returns nothing when vision is disabled', () => {
    const result = svc.selectImageMedia(
      { focal: ctxPost('focal', 0, [img('a.jpg')]), ancestors: [], descendants: [], totalDescendants: 0, rootId: 'root' } as any,
      { ...opts, visionEnabled: false },
    );
    expect(result.imageUrls).toEqual([]);
    expect(result.totalImages).toBe(0);
  });
});
