import {
  X_LINK_COST_MICROS,
  X_NATIVE_COST_MICROS,
  X_POST_MAX_IMAGES,
  X_POST_MAX_WEIGHTED,
  buildShareText,
  linkBlocker,
  nativeBlocker,
  resolveCrosspostMode,
  xPostCostMicros,
  xWeightedLength,
  type CrosspostPost,
  type NativeLimits,
} from './crosspost-eligibility';

const X_LIMITS: NativeLimits = { maxChars: X_POST_MAX_WEIGHTED, weighted: true, maxImages: X_POST_MAX_IMAGES };
const PICKAX_LIMITS: NativeLimits = { maxChars: 1000, weighted: false, maxImages: 10 };

function post(overrides: Partial<CrosspostPost> = {}): CrosspostPost {
  return {
    body: 'hello',
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

describe('x weighted length', () => {
  it('counts latin as 1, emoji and CJK as 2, and each url as 23', () => {
    expect(xWeightedLength('hello')).toBe(5);
    expect(xWeightedLength('🎉')).toBe(2);
    expect(xWeightedLength('你好')).toBe(4);
    expect(xWeightedLength('https://menofhunger.com/p/abc')).toBe(23);
    expect(xWeightedLength('hi https://x.com')).toBe(26);
    expect(xWeightedLength('see https://a.test/one and https://b.test/two')).toBe(4 + 23 + 5 + 23);
  });
});

describe('share text', () => {
  it('points at the original without copying it', () => {
    expect(buildShareText('https://menofhunger.com/p/1')).toBe(
      'Check this out on Men of Hunger https://menofhunger.com/p/1',
    );
    expect(buildShareText('https://menofhunger.com/a/1')).not.toContain('Hello');
  });
});

describe('cross-post modes', () => {
  it('allows a link for a poll and a long post, but not a private one', () => {
    expect(linkBlocker(post({ hasPoll: true }))).toBeNull();
    expect(linkBlocker(post({ body: 'a'.repeat(2000) }))).toBeNull();
    expect(linkBlocker(post({ visibility: 'onlyMe' }))).toBe('not_public');
    expect(linkBlocker(post({ parentId: 'p' }))).toBe('reply');
    expect(linkBlocker(post({ kind: 'checkin' }))).toBe('unsupported_kind');
  });

  it('blocks a native X post for polls, video, and text over 280 weighted characters', () => {
    expect(nativeBlocker(post({ hasPoll: true }), X_LIMITS)).toBe('poll');
    expect(nativeBlocker(post({ media: [{ kind: 'video', source: 'upload', r2Key: 'v', deletedAt: null }] }), X_LIMITS)).toBe(
      'unsupported_media',
    );
    expect(nativeBlocker(post({ body: 'a'.repeat(281) }), X_LIMITS)).toBe('too_long');
    expect(nativeBlocker(post({ body: '🎉'.repeat(141) }), X_LIMITS)).toBe('too_long');
    expect(nativeBlocker(post({ body: '🎉'.repeat(140) }), X_LIMITS)).toBeNull();
  });

  it('blocks a native Pickax post over 1000 characters or 10 images, and allows 1000', () => {
    expect(nativeBlocker(post({ body: 'a'.repeat(1001) }), PICKAX_LIMITS)).toBe('too_long');
    expect(nativeBlocker(post({ body: 'a'.repeat(1000) }), PICKAX_LIMITS)).toBeNull();
    const images = Array.from({ length: 11 }, () => ({ kind: 'image', source: 'upload', r2Key: 'a', deletedAt: null }));
    expect(nativeBlocker(post({ media: images }), PICKAX_LIMITS)).toBe('too_many_images');
  });

  it('downgrades a native request to a link when the post cannot be copied', () => {
    expect(resolveCrosspostMode(post({ hasPoll: true }), 'native', X_LIMITS)).toEqual({ mode: 'link' });
    expect(resolveCrosspostMode(post(), 'native', X_LIMITS)).toEqual({ mode: 'native' });
    expect(resolveCrosspostMode(post(), 'link', X_LIMITS)).toEqual({ mode: 'link' });
    expect(resolveCrosspostMode(post({ communityGroupId: 'g' }), 'native', X_LIMITS)).toEqual({ skip: 'group_post' });
  });

  it('bills any post that contains a url at the link rate', () => {
    expect(xPostCostMicros('just words')).toBe(X_NATIVE_COST_MICROS);
    expect(xPostCostMicros('see https://menofhunger.com/p/1')).toBe(X_LINK_COST_MICROS);
  });
});
