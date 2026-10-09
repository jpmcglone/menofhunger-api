export function viewerCanAccessVisibility(
  visibility: string,
  viewer: {
    verifiedStatus: string;
    premium: boolean;
    premiumPlus: boolean;
  } | null,
): boolean {
  if (visibility === "public") return true;
  if (!viewer) return false;
  const isPremium = viewer.premium || viewer.premiumPlus;
  const isVerified = viewer.verifiedStatus !== "none" || isPremium;
  if (visibility === "verifiedOnly") return isVerified;
  if (visibility === "premiumOnly") return isPremium;
  return false;
}

export function normalizeViewSource(
  source: string | null | undefined,
): string | null {
  const value = (source ?? "").toString().trim().slice(0, 80);
  return value || null;
}

export function breakdownCacheKey(postId: string): string {
  return `cache:post-view-breakdown:${postId}`;
}

export type PostViewBreakdown = {
  premium: number;
  verified: number;
  unverified: number;
  guest: number;
  /** Unique people — keep this name for shipped iOS. */
  total: number;
  totalViewCount: number;
  premiumTotal: number;
  verifiedTotal: number;
  unverifiedTotal: number;
  guestTotal: number;
};

export const BREAKDOWN_TTL_SECONDS = 60;

export const BATCH_MAX = 50;
