import type { Prisma, PostVisibility } from '@prisma/client';

/**
 * How the viewer's own posts are treated by a listing surface.
 * - `none`: no override; only tier-allowed visibilities (search).
 * - `excludeOnlyMe`: own posts stay visible after a tier downgrade, but never `onlyMe` (feeds).
 * - `includeOnlyMe`: own posts including `onlyMe` (topic listings).
 */
export type AuthorOverride = 'none' | 'excludeOnlyMe' | 'includeOnlyMe';

export type PostVisibilityWhereOptions = {
  viewerUserId: string | null;
  /** Result of `ViewerContextService.allowedPostVisibilities` for the viewer. */
  allowed: readonly PostVisibility[];
  authorOverride?: AuthorOverride;
};

/** Single source of truth for the Prisma `visibility` filter on post listings. */
export function buildPostVisibilityWhere(opts: PostVisibilityWhereOptions): Prisma.PostWhereInput {
  const { viewerUserId, allowed, authorOverride = 'none' } = opts;
  if (!viewerUserId) return { visibility: 'public' };
  const tier: Prisma.PostWhereInput = { visibility: { in: [...allowed] } };
  if (authorOverride === 'none') return tier;
  if (authorOverride === 'excludeOnlyMe') {
    return { OR: [tier, { userId: viewerUserId, visibility: { not: 'onlyMe' } }] };
  }
  return { OR: [tier, { userId: viewerUserId, visibility: 'onlyMe' }] };
}

/** In-memory counterpart for a single already-loaded post (realtime subscriptions). */
export function isPostVisibleToViewer(params: {
  visibility: string;
  isSelf: boolean;
  viewerIsVerified: boolean;
  viewerIsPremium: boolean;
}): boolean {
  const { visibility, isSelf, viewerIsVerified, viewerIsPremium } = params;
  if (isSelf) return true;
  if (visibility === 'onlyMe') return false;
  if (visibility === 'verifiedOnly') return viewerIsVerified;
  if (visibility === 'premiumOnly') return viewerIsPremium;
  return true;
}
