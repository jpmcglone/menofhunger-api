import { totalPostCommentsWhere, totalUserArticlesWhere, totalUserPostsWhere } from './content-counts';

describe('canonical content count filters', () => {
  it('counts every published post without viewer or visibility filters', () => {
    expect(totalUserPostsWhere('user-1')).toEqual({
      userId: 'user-1',
      deletedAt: null,
      isDraft: false,
    });
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
