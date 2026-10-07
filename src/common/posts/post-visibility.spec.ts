import { buildPostVisibilityWhere, isPostVisibleToViewer } from './post-visibility';

describe('buildPostVisibilityWhere', () => {
  const allowed = ['public', 'verifiedOnly'] as const;

  it('anonymous viewers only see public posts for every override', () => {
    for (const authorOverride of ['none', 'excludeOnlyMe', 'includeOnlyMe'] as const) {
      expect(buildPostVisibilityWhere({ viewerUserId: null, allowed, authorOverride })).toEqual({ visibility: 'public' });
    }
  });

  it('search semantics: tier only, never own onlyMe', () => {
    expect(buildPostVisibilityWhere({ viewerUserId: 'u1', allowed })).toEqual({ visibility: { in: ['public', 'verifiedOnly'] } });
  });

  it('feed semantics: own posts remain visible except onlyMe', () => {
    expect(buildPostVisibilityWhere({ viewerUserId: 'u1', allowed, authorOverride: 'excludeOnlyMe' })).toEqual({
      OR: [{ visibility: { in: ['public', 'verifiedOnly'] } }, { userId: 'u1', visibility: { not: 'onlyMe' } }],
    });
  });

  it('topic semantics: own onlyMe posts are included', () => {
    expect(buildPostVisibilityWhere({ viewerUserId: 'u1', allowed, authorOverride: 'includeOnlyMe' })).toEqual({
      OR: [{ visibility: { in: ['public', 'verifiedOnly'] } }, { userId: 'u1', visibility: 'onlyMe' }],
    });
  });
});

describe('isPostVisibleToViewer', () => {
  const base = { isSelf: false, viewerIsVerified: false, viewerIsPremium: false };
  it('gates by tier and onlyMe', () => {
    expect(isPostVisibleToViewer({ ...base, visibility: 'public' })).toBe(true);
    expect(isPostVisibleToViewer({ ...base, visibility: 'verifiedOnly' })).toBe(false);
    expect(isPostVisibleToViewer({ ...base, visibility: 'verifiedOnly', viewerIsVerified: true })).toBe(true);
    expect(isPostVisibleToViewer({ ...base, visibility: 'premiumOnly', viewerIsPremium: true })).toBe(true);
    expect(isPostVisibleToViewer({ ...base, visibility: 'onlyMe' })).toBe(false);
  });
  it('authors always see their own posts', () => {
    expect(isPostVisibleToViewer({ ...base, isSelf: true, visibility: 'onlyMe' })).toBe(true);
  });
});
