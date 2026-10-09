import { MAX_POST_LINKS, postLinkUrls, postLinksCreate, postLinksReplace } from './post-links';

describe('post links', () => {
  const body = 'Real discussion https://x.com/AP/status/1 and https://example.com (see https://x.com/AP/status/1)';

  it('normalizes like LinkMetadata keys and dedupes', () => {
    expect(postLinkUrls(body)).toEqual(['https://x.com/AP/status/1', 'https://example.com/']);
  });

  it('create: nested create of the link set, omitted when the body has no links', () => {
    expect(postLinksCreate(body)).toEqual({ create: [{ url: 'https://x.com/AP/status/1' }, { url: 'https://example.com/' }] });
    expect(postLinksCreate('no links here')).toBeUndefined();
  });

  it('edit: replaces the whole set (delete all, create the new links)', () => {
    expect(postLinksReplace('now only https://example.org/a')).toEqual({ deleteMany: {}, create: [{ url: 'https://example.org/a' }] });
    expect(postLinksReplace('links removed')).toEqual({ deleteMany: {}, create: [] });
  });

  it('caps links per post', () => {
    const many = Array.from({ length: MAX_POST_LINKS + 5 }, (_, i) => `https://e.com/${i}`).join(' ');
    expect(postLinkUrls(many)).toHaveLength(MAX_POST_LINKS);
  });
});
