import { BoardService } from './board.service';

const author = {
  id: 'author', username: 'james', name: 'James', premium: true, premiumPlus: false, isOrganization: false,
  verifiedStatus: 'identity', avatarKey: null, avatarUpdatedAt: null, bannedAt: null, orgMemberships: [],
};

function threadRow(overrides: Record<string, unknown> = {}) {
  return {
    id: 'thread-1', createdAt: new Date(), editedAt: null, editCount: 0, deletedAt: null,
    body: 'The body only readers with access should see.', isDraft: false, kind: 'board', boardOnly: false,
    visibility: 'premiumOnly', boostCount: 7, bookmarkCount: 0, commentCount: 3, repostCount: 0, quoteCount: 0,
    viewerCount: 12, totalViewCount: 12, parentId: null, rootId: null, communityGroupId: null, articleId: null,
    topics: [], hashtags: [], cashtags: [], checkinDayKey: null, checkinPrompt: null, userId: 'author',
    user: author, media: [{ id: 'm1', kind: 'image', source: 'upload', r2Key: 'uploads/author/images/a.webp', position: 0, deletedAt: null }],
    mentions: [], poll: null, article: null, fitnessShare: null,
    boardThread: {
      title: 'Show: I built a tiny app to track my kids chores and it changed our whole house',
      url: 'https://github.com/james/chores', domain: 'github.com', tags: ['show', 'build'], showInFeed: true,
    },
    ...overrides,
  };
}

function setup(viewer: Record<string, unknown> | null, row = threadRow()) {
  const prisma = {
    post: {
      findFirst: jest.fn().mockResolvedValue(row),
      findMany: jest.fn().mockResolvedValue([]),
      count: jest.fn().mockResolvedValue(0),
    },
    boardHide: { findMany: jest.fn().mockResolvedValue([]) },
    boardTag: { upsert: jest.fn().mockResolvedValue({}) },
    user: { update: jest.fn().mockResolvedValue({}) },
  };
  const posts = {
    viewerBoostedPostIds: jest.fn().mockResolvedValue(new Set()),
    viewerBookmarksByPostId: jest.fn().mockResolvedValue(new Map()),
    viewerLastSeenAtByPostId: jest.fn().mockResolvedValue(new Map([['thread-1', new Date()]])),
    createPost: jest.fn().mockResolvedValue({ post: { id: 'thread-1' } }),
  };
  const viewerContext = {
    getViewer: jest.fn().mockResolvedValue(viewer),
    getViewerOrThrow: jest.fn().mockResolvedValue(viewer),
    allowedPostVisibilities: jest.fn((v: any) => {
      const out = ['public'];
      if (v?.verifiedStatus && v.verifiedStatus !== 'none') out.push('verifiedOnly');
      if (v?.premium) out.push('premiumOnly');
      return out;
    }),
  };
  const realtime = { emitBoardNewThread: jest.fn(), emitPostsLiveUpdated: jest.fn() };
  const service = new BoardService(
    prisma as any,
    posts as any,
    viewerContext as any,
    { r2: () => ({ publicBaseUrl: 'https://cdn.example.com' }), frontendBaseUrl: () => 'https://menofhunger.com' } as any,
    realtime as any,
  );
  return { service, prisma, posts, realtime };
}

describe('BoardService access and teasers', () => {
  it('gives logged-out viewers a trimmed teaser of a premium thread, without link, text, image, or author', async () => {
    const { service } = setup(null);
    const thread = await service.getThread(null, 'thread-1');
    expect(thread.viewerCanAccess).toBe(false);
    expect(thread.title.endsWith('…')).toBe(true);
    expect(thread.url).toBeNull();
    expect(thread.domain).toBeNull();
    expect(thread.body).toBeNull();
    expect(thread.image).toBeNull();
    expect(thread.author).toBeNull();
    expect(thread.tags).toEqual(['show', 'build']);
    expect(thread.points).toBe(7);
    expect(thread.commentCount).toBe(3);
  });

  it('shows verified non-premium members the same teaser for premium threads', async () => {
    const { service } = setup({ id: 'v', verifiedStatus: 'identity', premium: false, premiumPlus: false, siteAdmin: false });
    const thread = await service.getThread('v', 'thread-1');
    expect(thread.viewerCanAccess).toBe(false);
    expect(thread.author).toBeNull();
  });

  it('shows the full thread to premium members', async () => {
    const { service } = setup({ id: 'p', verifiedStatus: 'identity', premium: true, premiumPlus: false, siteAdmin: false });
    const thread = await service.getThread('p', 'thread-1');
    expect(thread.viewerCanAccess).toBe(true);
    expect(thread.url).toBe('https://github.com/james/chores');
    expect(thread.body).toContain('body only readers');
    expect(thread.author?.username).toBe('james');
    expect(thread.image?.url).toContain('uploads/author/images/a.webp');
  });

  it('carries people and impressions like posts, plus whether you have seen it', async () => {
    const { service, prisma } = setup(
      { id: 'p', verifiedStatus: 'identity', premium: true, premiumPlus: false, siteAdmin: false },
      threadRow({ viewerCount: 12, totalViewCount: 40 }),
    );
    const thread = await service.getThread('p', 'thread-1');
    expect(thread.viewerCount).toBe(12);
    expect(thread.totalViewCount).toBe(40);
    expect(thread.viewerHasViewed).toBe(true);

    prisma.post.findFirst.mockResolvedValue(threadRow({ visibility: 'public', viewerCount: 3, totalViewCount: 1 }));
    const guest = await setup(null, threadRow({ visibility: 'public', viewerCount: 3, totalViewCount: 1 })).service.getThread(null, 'thread-1');
    expect(guest.totalViewCount).toBe(3);
    expect(guest.viewerHasViewed).toBeUndefined();
  });

  it('lets anyone read public threads, but hides comments of gated threads', async () => {
    const { service, prisma } = setup(null, threadRow({ visibility: 'public' }));
    expect((await service.getThread(null, 'thread-1')).viewerCanAccess).toBe(true);

    prisma.post.findFirst.mockResolvedValue(threadRow());
    const page = await service.listComments(null, 'thread-1', 'top');
    expect(page).toEqual({ viewerCanAccess: false, comments: [] });
  });
});

describe('BoardService list scope', () => {
  const listParams = {
    sort: 'new' as const, range: null, visibility: 'all' as const, tags: [], domain: null, q: null,
    authorUsername: null, limit: 30, cursor: null,
  };
  const viewer = { id: 'viewer', verifiedStatus: 'none', premium: false, siteAdmin: false };

  it('is site-wide: only visibility and the viewer’s own hides shape the list, never follows', async () => {
    const { service, prisma } = setup(viewer);
    await service.listThreads({ ...listParams, viewerUserId: 'viewer' });
    const where = JSON.stringify(prisma.post.findMany.mock.calls[0][0].where);
    expect(where).not.toMatch(/follow/i);
    expect(where).toContain('"boardHides":{"none":{"userId":"viewer"}}');
  });

  it('lists only the viewer’s hidden threads so they can be brought back', async () => {
    const { service, prisma } = setup(viewer);
    await service.listThreads({ ...listParams, viewerUserId: 'viewer', hiddenOnly: true });
    expect(JSON.stringify(prisma.post.findMany.mock.calls[0][0].where)).toContain('"boardHides":{"some":{"userId":"viewer"}}');
  });

  it('returns nothing for a signed-out hidden view', async () => {
    const { service, prisma } = setup(null);
    await expect(service.listThreads({ ...listParams, viewerUserId: null, hiddenOnly: true })).resolves.toEqual({ threads: [], nextCursor: null });
    expect(prisma.post.findMany).not.toHaveBeenCalled();
  });
});

describe('BoardService writes', () => {
  const member = { id: 'author', verifiedStatus: 'identity', premium: true, premiumPlus: false, siteAdmin: false };

  it('creates a thread as a kind=board post with one uploaded image, remembers the feed choice, and emits scope only', async () => {
    const { service, posts, prisma, realtime } = setup(member);
    await service.createThread('author', {
      title: '  Show:  chores app  ',
      url: 'github.com/james/chores?utm_source=hn',
      body: 'Text',
      image: { r2Key: 'uploads/author/images/a.webp', width: 800, height: 600, alt: null },
      tags: ['Show', '#build'],
      visibility: 'premiumOnly',
      showInFeed: false,
    });
    const call = posts.createPost.mock.calls[0][0];
    expect(call.kind).toBe('board');
    expect(call.board).toEqual(expect.objectContaining({
      title: 'Show: chores app', domain: 'github.com', tags: ['show', 'build'], showInFeed: false,
    }));
    expect(call.board.url).not.toContain('utm_source');
    expect(call.media).toEqual([expect.objectContaining({ source: 'upload', kind: 'image', r2Key: 'uploads/author/images/a.webp' })]);
    expect(prisma.user.update).toHaveBeenCalledWith({ where: { id: 'author' }, data: { boardShareToFeedDefault: false } });
    expect(realtime.emitBoardNewThread).toHaveBeenCalledWith({ threadId: 'thread-1', visibility: 'premiumOnly', tags: ['show', 'build'] });
  });

  it('rejects invalid links, too many tags, and bursts over the hourly limit', async () => {
    const { service, prisma } = setup(member);
    const base = { title: 'A fine title', url: null, body: null, image: null, tags: [], visibility: 'public' as const, showInFeed: true };
    await expect(service.createThread('author', { ...base, url: 'javascript:alert(1)' })).rejects.toThrow('valid http');
    await expect(service.createThread('author', { ...base, tags: ['a1', 'b2', 'c3', 'd4'] })).rejects.toThrow('up to 3 tags');
    prisma.post.count.mockResolvedValue(5);
    await expect(service.createThread('author', base)).rejects.toThrow('an hour');
  });

  it('keeps article-thread discussion on the article', async () => {
    const { service } = setup(member, threadRow({ articleId: 'article-1', visibility: 'public' }));
    await expect(service.createComment('author', 'thread-1', { body: 'hi', parentId: null })).rejects.toThrow('article');
  });
});
