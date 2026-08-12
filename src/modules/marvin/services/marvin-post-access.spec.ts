import { marvPublicProfilePostWhere, marvToolGroupAccessOr } from './marvin-post-access';

describe('marvPublicProfilePostWhere', () => {
  it('excludes every community-group post, not only private ones', () => {
    expect(marvPublicProfilePostWhere()).toEqual({ communityGroupId: null });
  });
});

describe('marvToolGroupAccessOr', () => {
  it('allows non-group and open-group posts when Marv is not in a thread', () => {
    expect(marvToolGroupAccessOr(null)).toEqual([
      { communityGroupId: null },
      { communityGroup: { deletedAt: null, joinPolicy: 'open' } },
    ]);
  });

  it('also allows the current thread so a private-group @marv mention still works', () => {
    const or = marvToolGroupAccessOr('r-1');
    expect(or).toContainEqual({ id: 'r-1' });
    expect(or).toContainEqual({ rootId: 'r-1' });
  });
});
