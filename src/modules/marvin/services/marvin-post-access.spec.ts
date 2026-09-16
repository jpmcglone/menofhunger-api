import { marvPublicProfilePostWhere, marvToolGroupAccessOr } from './marvin-post-access';

describe('marvPublicProfilePostWhere', () => {
  it('excludes every community-group post, not only private ones', () => {
    expect(marvPublicProfilePostWhere()).toEqual({ communityGroupId: null });
  });
});

describe('marvToolGroupAccessOr', () => {
  it('allows only non-group posts without a permitted group context', () => {
    expect(marvToolGroupAccessOr(null)).toEqual([
      { communityGroupId: null },
    ]);
  });

  it('allows only the explicitly permitted group', () => {
    expect(marvToolGroupAccessOr(null, 'group-1')).toEqual([
      { communityGroupId: null },
      { communityGroupId: 'group-1', communityGroup: { deletedAt: null } },
    ]);
  });

  it('also allows the current thread so a private-group @marv mention still works', () => {
    const or = marvToolGroupAccessOr('r-1');
    expect(or).toContainEqual({ id: 'r-1' });
    expect(or).toContainEqual({ rootId: 'r-1' });
  });
});
