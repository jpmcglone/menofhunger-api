import {
  articleBodyContainsKey,
  matchStoredAssetToKey,
  scrubKeyFromArticleBody,
} from './admin-image-review.references';

describe('matchStoredAssetToKey', () => {
  const key = 'dev/article-media/user1/abc123.jpg';
  const keySet = new Set([key]);
  const urlToKey = new Map([[`https://cdn.example/${key}`, key]]);

  it('matches a raw R2 key', () => {
    expect(matchStoredAssetToKey(key, keySet, urlToKey)).toBe(key);
  });

  it('matches an exact public URL', () => {
    expect(matchStoredAssetToKey(`https://cdn.example/${key}`, keySet, urlToKey)).toBe(key);
  });

  it('matches a URL with cache-bust query', () => {
    expect(matchStoredAssetToKey(`https://cdn.example/${key}?v=2026-01-01`, keySet, urlToKey)).toBe(key);
  });

  it('matches when CDN host differs but path ends with the key', () => {
    expect(matchStoredAssetToKey(`https://other.cdn/${key}`, keySet, urlToKey)).toBe(key);
  });

  it('returns null for unrelated values', () => {
    expect(matchStoredAssetToKey('https://cdn.example/other.jpg', keySet, urlToKey)).toBeNull();
    expect(matchStoredAssetToKey(null, keySet, urlToKey)).toBeNull();
  });
});

describe('articleBodyContainsKey / scrubKeyFromArticleBody', () => {
  const key = 'dev/article-media/u1/photo.webp';
  const body = JSON.stringify({
    type: 'doc',
    content: [
      { type: 'paragraph', content: [{ type: 'text', text: 'Hello' }] },
      {
        type: 'image',
        attrs: { src: `https://cdn.example/${key}`, alt: null },
      },
      {
        type: 'image',
        attrs: { src: 'https://cdn.example/dev/article-media/u1/keep.webp', alt: null },
      },
    ],
  });

  it('detects the key inside TipTap JSON', () => {
    expect(articleBodyContainsKey(body, key)).toBe(true);
    expect(articleBodyContainsKey(body, 'missing-key')).toBe(false);
  });

  it('removes only image nodes that reference the key', () => {
    const { body: next, changed } = scrubKeyFromArticleBody(body, key);
    expect(changed).toBe(true);
    expect(articleBodyContainsKey(next, key)).toBe(false);
    expect(next).toContain('keep.webp');
    expect(next).toContain('Hello');
  });

  it('is a no-op when the key is absent', () => {
    const { body: next, changed } = scrubKeyFromArticleBody(body, 'nope');
    expect(changed).toBe(false);
    expect(next).toBe(body);
  });
});
