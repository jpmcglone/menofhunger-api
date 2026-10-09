import { NotFoundException } from '@nestjs/common';
import { LinksPageService, plainExcerpt } from './links-page.service';

const baseUser = {
  id: 'u1',
  username: 'alice',
  usernameIsSet: true,
  bannedAt: null,
  name: 'Alice',
  bio: 'bio',
  locationDisplay: 'Austin, TX',
  verifiedStatus: 'manual',
  isOrganization: false,
  premium: true,
  premiumPlus: false,
  avatarKey: null,
  avatarUpdatedAt: null,
  avatarVideoKey: null,
  avatarVideoDurationMs: null,
  referralCode: 'CODE1',
  xUsername: '@Alice_X',
  pickaxUsername: 'alice',
  showXFollowerCount: false,
  xConnection: { xUserId: '123', username: 'alice_x' },
  pickaxConnection: { username: 'Alice' },
};

function makeService(over: { user?: any; block?: any; rows?: any[]; snapshot?: any; posts?: any[]; articles?: any[] } = {}) {
  const user = over.user === undefined ? baseUser : over.user;
  const prisma: any = {
    user: { findFirst: jest.fn(async () => user), findUnique: jest.fn(async () => user) },
    userBlock: { findFirst: jest.fn(async () => over.block ?? null) },
    article: { findMany: jest.fn(async () => over.articles ?? []) },
  };
  const postsRead: any = { findMany: jest.fn(async () => over.posts ?? []) };
  const profileLinks: any = { listRows: jest.fn(async () => over.rows ?? []) };
  const linksWrite: any = { setShowXFollowerCount: jest.fn(async () => undefined) };
  const xSnapshots: any = { profile: jest.fn(async () => over.snapshot ?? null) };
  const boom = () => {
    throw new Error('must not be called on the public path');
  };
  const xPreview: any = { get: jest.fn(boom), context: jest.fn(boom) };
  const appConfig: any = { r2: () => null };
  const service = new LinksPageService(prisma, appConfig, postsRead, profileLinks, linksWrite, xSnapshots, xPreview);
  return { service, prisma, postsRead, profileLinks, linksWrite, xSnapshots, xPreview };
}

const row = (id: string, url: string, grandfathered = false) => ({
  id,
  url,
  title: id,
  position: 0,
  legacyField: null,
  grandfathered,
});

describe('LinksPageService.getPage', () => {
  it.each([
    ['unknown user', null],
    ['username not set', { ...baseUser, usernameIsSet: false }],
    ['banned', { ...baseUser, bannedAt: new Date() }],
  ])('404s for %s', async (_label, user) => {
    const { service } = makeService({ user });
    await expect(service.getPage('alice', null)).rejects.toBeInstanceOf(NotFoundException);
  });

  it('404s when the signed-in viewer has a block in either direction', async () => {
    const { service, prisma } = makeService({ block: { blockerId: 'v1' } });
    await expect(service.getPage('alice', 'v1')).rejects.toBeInstanceOf(NotFoundException);
    expect(prisma.userBlock.findFirst.mock.calls[0][0].where.OR).toEqual([
      { blockerId: 'v1', blockedId: 'u1' },
      { blockerId: 'u1', blockedId: 'v1' },
    ]);
  });

  it('does not check blocks for anonymous viewers', async () => {
    const { service, prisma } = makeService();
    await service.getPage('Alice', null);
    expect(prisma.userBlock.findFirst).not.toHaveBeenCalled();
  });

  it('filters links by visibility and re-validates URLs', async () => {
    const rows = [
      row('ok', 'https://example.com/a'),
      row('bad', 'https://bit.ly/x'),
      row('secret', 'https://example.com/?token=1'),
    ];
    const verified = await makeService({ rows }).service.getPage('alice', null);
    expect(verified.links.map((l) => l.id)).toEqual(['ok']);
    expect(verified.links[0]).toMatchObject({ host: 'example.com', icon: 'website' });

    const unverified = await makeService({
      user: { ...baseUser, verifiedStatus: 'none' },
      rows: [row('g', 'https://example.com/g', true), row('n', 'https://example.com/n', false)],
    }).service.getPage('alice', null);
    expect(unverified.links.map((l) => l.id)).toEqual(['g']);
  });

  it('computes connected accounts from live connections (error status still counts)', async () => {
    const { service } = makeService();
    const page = await service.getPage('alice', null);
    expect(page.connectedAccounts).toEqual([
      { network: 'x', handle: 'Alice_X', url: 'https://x.com/Alice_X', followerCount: null },
      { network: 'pickax', handle: 'alice', url: 'https://pickax.com/alice', followerCount: null },
    ]);

    const noConn = await makeService({
      user: { ...baseUser, xConnection: null, pickaxConnection: { username: 'someone-else' } },
    }).service.getPage('alice', null);
    expect(noConn.connectedAccounts).toEqual([]);
  });

  it('shows the follower count only when opted in and a fresh snapshot exists', async () => {
    const off = makeService({ snapshot: { followers: 99 } });
    expect((await off.service.getPage('alice', null)).connectedAccounts[0].followerCount).toBeNull();
    expect(off.xSnapshots.profile).not.toHaveBeenCalled();

    const stale = makeService({ user: { ...baseUser, showXFollowerCount: true }, snapshot: null });
    expect((await stale.service.getPage('alice', null)).connectedAccounts[0].followerCount).toBeNull();

    const fresh = makeService({ user: { ...baseUser, showXFollowerCount: true }, snapshot: { followers: 1234 } });
    const page = await fresh.service.getPage('alice', null);
    expect(page.connectedAccounts[0].followerCount).toBe(1234);
    expect(fresh.xSnapshots.profile).toHaveBeenCalledWith('123', 'alice_x');
    // Public path never touches the paid X preview/API/budget path.
    expect(fresh.xPreview.get).not.toHaveBeenCalled();
    expect(fresh.xPreview.context).not.toHaveBeenCalled();
  });

  it('returns at most 3 merged recent items with plain excerpts and does not mint referral codes', async () => {
    const long = 'x'.repeat(300);
    const { service, postsRead, prisma } = makeService({
      posts: [
        { id: 'p1', body: `hello   \n world`, createdAt: new Date('2026-01-03') },
        { id: 'p2', body: long, createdAt: new Date('2026-01-01') },
      ],
      articles: [
        { id: 'a1', title: 'Title', excerpt: 'Ex', publishedAt: new Date('2026-01-02'), createdAt: new Date('2025-12-01') },
        { id: 'a2', title: 'Old', excerpt: null, publishedAt: new Date('2025-01-02'), createdAt: new Date('2025-01-01') },
      ],
    });
    const page = await service.getPage('alice', null);
    expect(page.recent.map((r) => r.id)).toEqual(['p1', 'a1', 'p2']);
    expect(page.recent[0]).toMatchObject({ kind: 'post', title: null, excerpt: 'hello world' });
    expect(page.recent[1]).toMatchObject({ kind: 'article', title: 'Title', excerpt: 'Ex' });
    expect(page.recent[2].excerpt).toHaveLength(140);
    expect(page.referralCode).toBe('CODE1');
    expect(postsRead.findMany.mock.calls[0][0].where).toMatchObject({ visibility: 'public', parentId: null });
    expect(prisma.article.findMany.mock.calls[0][0].where).toMatchObject({ visibility: 'public' });
  });
});

describe('LinksPageService owner paths', () => {
  const owner = { ...baseUser, verifiedStatus: 'none', showXFollowerCount: true };

  it('getMine flags hidden links, reports capabilities, and warms the snapshot without blocking', async () => {
    const m = makeService({ user: owner, rows: [row('g', 'https://example.com/g', true), row('n', 'https://example.com/n')] });
    m.xPreview.get.mockResolvedValue(null);
    const out = await m.service.getMine('u1');
    expect(out.links.map((l) => [l.id, l.hiddenUntilVerified, l.grandfathered])).toEqual([
      ['g', false, true],
      ['n', true, false],
    ]);
    expect(out).toMatchObject({ canAddCustomLinks: false, maxLinks: 10, path: '/u/alice/links' });
    expect(out.connectedAccounts[0]).toMatchObject({ supportsFollowerCount: true, showFollowerCount: true });
    expect(out.connectedAccounts[1]).toMatchObject({ supportsFollowerCount: false, showFollowerCount: false });
    expect(m.xPreview.get).toHaveBeenCalledWith('u1', 'u1');
  });

  it('settings PATCH warms the snapshot only when turned on', async () => {
    const on = makeService({ user: owner });
    on.xPreview.get.mockResolvedValue(null);
    await on.service.updateSettings('u1', { showXFollowerCount: true });
    expect(on.linksWrite.setShowXFollowerCount).toHaveBeenCalledWith('u1', true);
    expect(on.xPreview.get).toHaveBeenCalledTimes(1);

    const off = makeService({ user: { ...owner, showXFollowerCount: false } });
    await off.service.updateSettings('u1', { showXFollowerCount: false });
    expect(off.xPreview.get).not.toHaveBeenCalled();
    await expect(off.service.updateSettings('u1', { showXFollowerCount: 'yes' })).rejects.toBeDefined();
  });

  it('a failing warm-up never breaks the settings response', async () => {
    const m = makeService({ user: owner });
    m.xPreview.get.mockRejectedValue(new Error('budget'));
    await expect(m.service.updateSettings('u1', { showXFollowerCount: true })).resolves.toBeDefined();
  });
});

describe('plainExcerpt', () => {
  it('collapses whitespace and truncates with an ellipsis', () => {
    expect(plainExcerpt('a\n\n b')).toBe('a b');
    expect(plainExcerpt(null)).toBe('');
    expect(plainExcerpt('y'.repeat(200))).toHaveLength(140);
  });
});
