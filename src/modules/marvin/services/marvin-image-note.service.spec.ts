import { MarvinImageNoteService } from './marvin-image-note.service';

const BASE = 'https://cdn.test';

function post(over: Record<string, unknown> = {}) {
  return {
    body: '',
    hashtags: [],
    media: [{ kind: 'image', source: 'upload', r2Key: 'posts/a.jpg', url: null, thumbnailR2Key: null }],
    ...over,
  };
}

function make(opts: { post?: unknown; notes?: string[]; created?: number } = {}) {
  const prisma: any = {
    post: { findFirst: jest.fn(async () => (opts.post === undefined ? post() : opts.post)) },
    mediaSearchNote: {
      findMany: jest.fn(async () => (opts.notes ?? []).map((r2Key) => ({ r2Key }))),
      createMany: jest.fn(async () => ({ count: opts.created ?? 1 })),
    },
  };
  const sideEffects: any = { dispatch: jest.fn() };
  const appConfig: any = { r2: () => ({ publicBaseUrl: BASE }) };
  return { svc: new MarvinImageNoteService(prisma, appConfig, sideEffects), prisma, sideEffects };
}

const viewing = [`${BASE}/posts/a.jpg`];

describe('MarvinImageNoteService.candidateForPost', () => {
  it('offers the one undescribed upload Marv is viewing on a thin post', async () => {
    const { svc, prisma } = make();
    await expect(svc.candidateForPost('p1', viewing)).resolves.toEqual({ r2Key: 'posts/a.jpg', postId: 'p1', imageUrl: viewing[0] });
    // Only uploads that are images or videos are even loaded; GIFs and provider media never qualify.
    expect(prisma.post.findFirst.mock.calls[0][0].select.media.where).toMatchObject({ source: 'upload', kind: { in: ['image', 'video'] } });
    // Private posts, drafts, deleted posts and reposts are filtered by the query.
    expect(prisma.post.findFirst.mock.calls[0][0].where).toMatchObject({ deletedAt: null, isDraft: false, visibility: { not: 'onlyMe' } });
  });

  it('uses a video poster key and URL', async () => {
    const { svc } = make({ post: post({ media: [{ kind: 'video', source: 'upload', r2Key: 'posts/v.mp4', url: null, thumbnailR2Key: 'posts/v.jpg' }] }) });
    await expect(svc.candidateForPost('p1', [`${BASE}/posts/v.jpg`])).resolves.toMatchObject({ r2Key: 'posts/v.jpg' });
  });

  it('skips a caption that search already covers', async () => {
    await expect(make({ post: post({ body: 'Leg day at the garage gym today' }) }).svc.candidateForPost('p1', viewing)).resolves.toBeNull();
    await expect(make({ post: post({ hashtags: ['gym'] }) }).svc.candidateForPost('p1', viewing)).resolves.toBeNull();
  });

  it('skips an image Marv was not shown, an already described file, and an ineligible post', async () => {
    await expect(make().svc.candidateForPost('p1', [`${BASE}/other.jpg`])).resolves.toBeNull();
    await expect(make().svc.candidateForPost('p1', [])).resolves.toBeNull();
    await expect(make({ notes: ['posts/a.jpg'] }).svc.candidateForPost('p1', viewing)).resolves.toBeNull();
    await expect(make({ post: null }).svc.candidateForPost('p1', viewing)).resolves.toBeNull();
  });
});

describe('MarvinImageNoteService.record', () => {
  const candidate = { r2Key: 'posts/a.jpg', postId: 'p1', imageUrl: viewing[0] };

  it('stores a cleaned note and dispatches indexing after the write', async () => {
    const { svc, prisma, sideEffects } = make();
    await expect(svc.record(candidate, '  A red bench\nin a garage gym https://x.test/a ')).resolves.toBe(true);
    expect(prisma.mediaSearchNote.createMany).toHaveBeenCalledWith({
      data: [{ r2Key: 'posts/a.jpg', note: 'A red bench in a garage gym', postId: 'p1' }],
      skipDuplicates: true,
    });
    expect(sideEffects.dispatch).toHaveBeenCalledWith('media.searchNote.recorded', { postId: 'p1', r2Key: 'posts/a.jpg' });
  });

  it('keeps the first note when the file was described in the meantime', async () => {
    const { svc, sideEffects } = make({ created: 0 });
    await expect(svc.record(candidate, 'A bench')).resolves.toBe(false);
    expect(sideEffects.dispatch).not.toHaveBeenCalled();
  });

  it('refuses unusable text and posts that are no longer eligible', async () => {
    const a = make();
    await expect(a.svc.record(candidate, 42)).resolves.toBe(false);
    await expect(a.svc.record(candidate, ' ?')).resolves.toBe(false);
    expect(a.prisma.mediaSearchNote.createMany).not.toHaveBeenCalled();
    const gone = make({ post: null });
    await expect(gone.svc.record(candidate, 'A bench')).resolves.toBe(false);
    const edited = make({ post: post({ body: 'Now it has a long caption of its own' }) });
    await expect(edited.svc.record(candidate, 'A bench')).resolves.toBe(false);
    const other = make({ post: post({ media: [{ kind: 'image', source: 'upload', r2Key: 'posts/z.jpg', url: null, thumbnailR2Key: null }] }) });
    await expect(other.svc.record(candidate, 'A bench')).resolves.toBe(false);
  });

  it('caps note length', () => {
    expect(MarvinImageNoteService.sanitize('word '.repeat(100))!.length).toBeLessThanOrEqual(200);
  });
});
