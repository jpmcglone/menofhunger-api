import { openSecret, sealSecret } from '../../common/crypto/secret-box';
import { profileMatchesIdentity, profileVerificationCode, readTokenIdentity } from './pickax-identity';
import {
  articleCrosspostBlocker,
  buildPickaxArticlePayload,
  buildPickaxLinkPayload,
  buildPickaxPostPayload,
  pickaxArticleUrl,
  pickaxPostUrl,
  postCrosspostBlocker,
  tiptapBodyToHtml,
  type PickaxArticleSource,
  type PickaxPostSource,
} from './pickax-content';

const KEY = 'k'.repeat(40);

function jwt(claims: Record<string, unknown>): string {
  const enc = (o: unknown) => Buffer.from(JSON.stringify(o)).toString('base64url');
  return `${enc({ alg: 'none' })}.${enc(claims)}.sig`;
}

function post(overrides: Partial<PickaxPostSource> = {}): PickaxPostSource {
  return {
    id: 'p1',
    body: 'hello world',
    visibility: 'public',
    kind: 'regular',
    boardOnly: false,
    isDraft: false,
    deletedAt: null,
    scheduledAt: null,
    parentId: null,
    communityGroupId: null,
    quotedPostId: null,
    repostedPostId: null,
    hasPoll: false,
    media: [],
    ...overrides,
  };
}

describe('Pickax public links', () => {
  it('builds post and article permalinks', () => {
    expect(pickaxPostUrl('794776')).toBe('https://pickax.com/post/794776');
    expect(pickaxArticleUrl('249026')).toBe('https://pickax.com/articles/249026');
  });
});

describe('pickax secret box', () => {
  it('round-trips and rejects a different key', () => {
    const sealed = sealSecret('s3cret', KEY);
    expect(sealed).not.toContain('s3cret');
    expect(openSecret(sealed, KEY)).toBe('s3cret');
    expect(() => openSecret(sealed, 'x'.repeat(40))).toThrow();
  });
});

describe('pickax identity', () => {
  it('reads a handle and numeric id from token claims', () => {
    expect(readTokenIdentity(jwt({ username: '@alice', sub: 'user-42' }))).toEqual({ handle: 'alice', userId: '42' });
  });

  it('derives a stable profile code bound to the user and handle', () => {
    const code = profileVerificationCode('u1', 'Alice', KEY);
    expect(code).toMatch(/^moh-verify-[0-9a-f]{10}$/);
    expect(profileVerificationCode('u1', 'alice', KEY)).toBe(code);
    expect(profileVerificationCode('u2', 'alice', KEY)).not.toBe(code);
    expect(profileVerificationCode('u1', 'bob', KEY)).not.toBe(code);
  });

  it('yields nothing for opaque tokens', () => {
    expect(readTokenIdentity('opaque-token')).toEqual({ handle: null, userId: null });
  });

  it('matches by numeric id only through the avatar path', () => {
    const identity = { handle: 'alice', userId: '42' };
    expect(profileMatchesIdentity('<img src="https://img.pickax.com/user-42/a.jpg">', identity)).toBe(true);
    expect(profileMatchesIdentity('<img src="https://img.pickax.com/user-421/a.jpg">', identity)).toBe(false);
    expect(profileMatchesIdentity('@alice', identity)).toBe(false);
  });

  it('matches by handle when no id is known and rejects lookalikes', () => {
    const identity = { handle: 'alice', userId: null };
    expect(profileMatchesIdentity('Profile @alice on Pickax', identity)).toBe(true);
    expect(profileMatchesIdentity('Profile @alice2 on Pickax', identity)).toBe(false);
    expect(profileMatchesIdentity('', identity)).toBe(false);
  });
});

describe('pickax post eligibility and payload', () => {
  it('accepts a plain public post', () => {
    expect(postCrosspostBlocker(post())).toBeNull();
  });

  it.each([
    ['not_public', { visibility: 'verifiedOnly' as const }],
    ['group_post', { communityGroupId: 'g' }],
    ['unsupported_kind', { boardOnly: true }],
    ['unsupported_kind', { kind: 'checkin' as const }],
    ['unsupported_kind', { kind: 'status' as const }],
    ['unsupported_kind', { kind: 'fitnessShare' as const }],
    ['reply', { parentId: 'x' }],
    ['quote_or_repost', { quotedPostId: 'x' }],
    ['poll', { hasPoll: true }],
    ['too_long', { body: 'a'.repeat(1001) }],
    ['not_published', { isDraft: true }],
  ])('blocks %s', (reason, overrides) => {
    expect(postCrosspostBlocker(post(overrides))).toBe(reason);
  });

  it('blocks video and allows uploaded images', () => {
    const image = { kind: 'image' as const, source: 'upload' as const, r2Key: 'a.jpg', alt: null, deletedAt: null, position: 0 };
    expect(postCrosspostBlocker(post({ media: [image] }))).toBeNull();
    expect(postCrosspostBlocker(post({ media: [{ ...image, kind: 'video' }] }))).toBe('unsupported_media');
  });

  it('preserves user links and adds attribution in full-copy mode', () => {
    const payload = buildPickaxPostPayload(post({ body: 'see https://example.com' }), {
      publicBaseUrl: 'https://cdn.example.com', canonicalUrl: 'https://menofhunger.com/p/p1',
    });
    expect(payload.content).toContain('see https://example.com');
    expect(payload.content).toContain('Originally published on Men of Hunger\nhttps://menofhunger.com/p/p1');
    expect(payload.link).toBeUndefined();
  });

  it('puts the Men of Hunger url in a link post', () => {
    const payload = buildPickaxLinkPayload('https://menofhunger.com/p/p1');
    expect(payload.content).toBe('Check this out on Men of Hunger https://menofhunger.com/p/p1');
    expect(payload.link).toBe('https://menofhunger.com/p/p1');
  });
});

describe('pickax article translation', () => {
  const doc = JSON.stringify({
    type: 'doc',
    content: [
      { type: 'heading', attrs: { level: 1 }, content: [{ type: 'text', text: 'Hi <b>' }] },
      { type: 'paragraph', content: [{ type: 'text', text: 'bold', marks: [{ type: 'bold' }] }] },
      { type: 'youtube', attrs: { src: 'https://www.youtube.com/watch?v=abc' } },
    ],
  });

  it('escapes text and turns embeds into links', () => {
    const html = tiptapBodyToHtml(doc);
    expect(html).toContain('<h2>Hi &lt;b&gt;</h2>');
    expect(html).toContain('<strong>bold</strong>');
    expect(html).toContain('<a href="https://www.youtube.com/watch?v=abc">');
    expect(html).not.toContain('<iframe');
  });

  it('appends the author footer and thumbnail', () => {
    const article: PickaxArticleSource = {
      id: 'a1',
      title: ' Title ',
      body: doc,
      visibility: 'public',
      isDraft: false,
      publishedAt: new Date(),
      deletedAt: null,
      thumbnailR2Key: 'thumb.jpg',
    };
    expect(articleCrosspostBlocker(article)).toBeNull();
    const payload = buildPickaxArticlePayload(article, {
      publicBaseUrl: 'https://cdn.example.com',
      author: { name: 'Al', username: 'al' },
      siteBaseUrl: 'https://menofhunger.com',
    });
    expect(payload.title).toBe('Title');
    expect(payload.thumbnail).toContain('thumb.jpg');
    expect(payload.content).toContain('<a href="https://menofhunger.com/u/al">Al</a> on Men of Hunger');
  });

  it('blocks drafts and non-public articles', () => {
    const base = { id: 'a', title: 't', body: '{}', visibility: 'public', isDraft: false, publishedAt: new Date(), deletedAt: null, thumbnailR2Key: null } as PickaxArticleSource;
    expect(articleCrosspostBlocker({ ...base, isDraft: true })).toBe('not_published');
    expect(articleCrosspostBlocker({ ...base, visibility: 'verifiedOnly' })).toBe('not_public');
  });
});
