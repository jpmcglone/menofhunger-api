import { totalPostCommentsWhere, totalUserArticlesWhere, totalUserPostsWhere } from './content-counts';

describe('canonical content count filters', () => {
  it('counts every published post across audience tiers, without viewer filters', () => {
    expect(totalUserPostsWhere('user-1')).toEqual({
      userId: 'user-1',
      deletedAt: null,
      isDraft: false,
      visibility: { not: 'onlyMe' },
    });
  });

  it('excludes only-me posts so the total matches what a profile feed can show', () => {
    // Profile feeds never return onlyMe posts (not even to the author — those
    // live behind /posts/only-me), so counting them would print a total the
    // viewer cannot reconcile with the list, and would leak how much private
    // material a member keeps to anonymous public-profile callers.
    expect(totalUserPostsWhere('user-1').visibility).toEqual({ not: 'onlyMe' });
  });

  it('counts every published article without viewer or visibility filters', () => {
    expect(totalUserArticlesWhere('user-1')).toEqual({
      authorId: 'user-1',
      deletedAt: null,
      isDraft: false,
      publishedAt: { not: null },
    });
  });

  it('counts all direct published comments without viewer filters', () => {
    expect(totalPostCommentsWhere('post-1')).toEqual({
      parentId: 'post-1',
      deletedAt: null,
      isDraft: false,
    });
  });
});
