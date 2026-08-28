import { MarvinThreadContextService } from './marvin-thread-context.service';

/**
 * MarvinThreadContextService loads the full public thread (same root), then
 * splits it into posts before the focal (ancestors) and after it (descendants).
 */

function makeService(opts: {
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
  focalMeta?: { id: string; rootId: string | null } | null;
  totalInThread?: number;
  marvUserId?: string | null;
}) {
  const mapped = opts.postRows.map((p) => ({
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
    communityGroupId: null as string | null,
    communityGroup: null as {
      name: string;
      description: string | null;
      rules: string | null;
      joinPolicy: 'open' | 'approval';
      memberCount: number;
      deletedAt: Date | null;
    } | null,
  }));

  const findFirst = jest.fn(async () => {
    if (opts.focalMeta === null) return null;
    if (opts.focalMeta) return opts.focalMeta;
    const focal = opts.postRows.find((p) => p.id === 'focal') ?? opts.postRows[0];
    return focal ? { id: focal.id, rootId: focal.rootId } : null;
  });
  const count = jest.fn(async () => opts.totalInThread ?? opts.postRows.length);
  const findMany = jest.fn(async () => mapped);

  const prisma: any = {
    post: { findFirst, count, findMany },
  };
  const identity: any = {
    getMarvUserId: jest.fn(async () => opts.marvUserId ?? null),
  };

  return {
    service: new MarvinThreadContextService(prisma, identity),
    findFirst,
    findMany,
    count,
  };
}

function post(
  id: string,
  parentId: string | null,
  rootId: string | null,
  minute: number,
  userId = 'u-' + id,
  username = id,
) {
  return {
    id,
    parentId,
    rootId,
    body: `body ${id}`,
    createdAt: new Date(`2026-01-01T00:${String(minute).padStart(2, '0')}:00Z`),
    checkinPrompt: null,
    userId,
    username,
    name: id.toUpperCase(),
  };
}

describe('MarvinThreadContextService', () => {
  it('returns empty context for a blank focal id', async () => {
    const { service, findFirst } = makeService({ postRows: [] });
    const result = await service.collect({ focalPostId: '   ' });
    expect(result).toEqual({
      focal: null,
      ancestors: [],
      descendants: [],
      totalDescendants: 0,
      rootId: null,
      group: null,
    });
    expect(findFirst).not.toHaveBeenCalled();
  });

  it('assembles the full thread around the focal post, including sibling branches', async () => {
    const { service } = makeService({
      postRows: [
        post('root', null, null, 0),
        post('parent', 'root', 'root', 1),
        post('sibling', 'parent', 'root', 2),
        post('focal', 'parent', 'root', 3),
        post('child', 'focal', 'root', 4),
      ],
    });

    const result = await service.collect({ focalPostId: 'focal' });

    expect(result.focal?.id).toBe('focal');
    expect(result.ancestors.map((a) => a.id)).toEqual(['root', 'parent', 'sibling']);
    expect(result.descendants.map((d) => d.id)).toEqual(['child']);
    expect(result.totalDescendants).toBe(4);
    expect(result.rootId).toBe('root');
  });

  it('windows a huge thread around the focal post but reports the true thread size', async () => {
    const postRows = [
      post('root', null, null, 0),
      ...Array.from({ length: 5 }, (_, i) => post(`d${i}`, 'root', 'root', i + 1)),
      post('focal', 'root', 'root', 6),
      post('after', 'focal', 'root', 7),
    ];
    const { service } = makeService({ postRows, totalInThread: 20 });

    const result = await service.collect({ focalPostId: 'focal', threadLimit: 4 });

    expect(result.focal?.id).toBe('focal');
    expect([
      ...result.ancestors.map((a) => a.id),
      result.focal?.id,
      ...result.descendants.map((d) => d.id),
    ]).toHaveLength(4);
    expect(result.totalDescendants).toBe(19);
  });

  it('flags Marv-authored posts', async () => {
    const { service } = makeService({
      postRows: [
        post('focal', null, null, 0, 'u-focal', 'focal'),
        post('marv-reply', 'focal', 'focal', 1, 'marv-user', 'marv'),
      ],
      marvUserId: 'marv-user',
    });

    const result = await service.collect({ focalPostId: 'focal' });
    expect(result.descendants[0]?.isMarv).toBe(true);
    expect(result.focal?.isMarv).toBe(false);
  });

  it('returns the community group on the focal post', async () => {
    const { service, findMany } = makeService({
      postRows: [post('focal', null, null, 0)],
    });
    findMany.mockResolvedValueOnce([
      {
        id: 'focal',
        parentId: null,
        rootId: null,
        body: 'body focal',
        createdAt: new Date('2026-01-01T00:00:00Z'),
        editedAt: null,
        checkinPrompt: null,
        userId: 'u-focal',
        user: { username: 'focal', name: 'FOCAL' },
        media: [],
        poll: null,
        communityGroupId: 'g-1',
        communityGroup: {
          name: 'Morning Fasters',
          description: 'Fast before sunrise.',
          rules: 'No selling.',
          joinPolicy: 'approval',
          memberCount: 12,
          deletedAt: null,
        },
      },
    ]);
    const result = await service.collect({ focalPostId: 'focal' });
    expect(result.group).toEqual({
      name: 'Morning Fasters',
      description: 'Fast before sunrise.',
      rules: 'No selling.',
      joinPolicy: 'approval',
      memberCount: 12,
    });
  });
});

// ── selectImageMedia: include EVERY image (multiple per post + throughout the thread) ──
function img(key: string) {
  return { kind: 'image', source: 'upload', r2Key: key, url: null };
}
function ctxPost(id: string, depth: number, media: Array<{ kind: string; source: string; r2Key: string | null; url: string | null; thumbnailR2Key?: string | null }>) {
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
    media: media.map((m) => ({ thumbnailR2Key: null, ...m })),
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

  it('includes video poster thumbnails and skips videos without one', () => {
    const result = svc.selectImageMedia(
      {
        focal: ctxPost('focal', 0, [
          { kind: 'video', source: 'upload', r2Key: 'posts/clip.mp4', url: null, thumbnailR2Key: 'posts/clip.jpg' },
          { kind: 'video', source: 'upload', r2Key: 'posts/bare.mp4', url: null, thumbnailR2Key: null },
          img('still.jpg'),
        ]),
        ancestors: [],
        descendants: [],
        totalDescendants: 0,
        rootId: 'root',
      } as any,
      opts,
    );
    expect(result.imageUrls).toEqual(['https://cdn.test/posts/clip.jpg', 'https://cdn.test/still.jpg']);
  });
});
