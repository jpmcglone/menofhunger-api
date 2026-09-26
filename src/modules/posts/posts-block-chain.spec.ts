import { postChainInvolvesAuthor } from './posts.utils';

describe('postChainInvolvesAuthor', () => {
  const blocked = new Set(['blocked']);
  const by = (id: string, extra: Record<string, unknown> = {}) => ({ author: { id }, ...extra });

  it('matches the author, any thread ancestor, and reposted or quoted posts', () => {
    expect(postChainInvolvesAuthor(by('blocked'), blocked)).toBe(true);
    expect(postChainInvolvesAuthor(by('a', { parent: by('b', { parent: by('blocked') }) }), blocked)).toBe(true);
    expect(postChainInvolvesAuthor(by('a', { repostedPost: by('blocked') }), blocked)).toBe(true);
    expect(postChainInvolvesAuthor(by('a', { quotedPost: by('blocked') }), blocked)).toBe(true);
  });

  it('keeps unrelated posts and ignores an empty block set', () => {
    expect(postChainInvolvesAuthor(by('a', { parent: by('b') }), blocked)).toBe(false);
    expect(postChainInvolvesAuthor(by('blocked'), new Set())).toBe(false);
    expect(postChainInvolvesAuthor(null, blocked)).toBe(false);
  });
});
