export const ANNOUNCEMENT_CADENCE_MS = 24 * 60 * 60 * 1000;
export const AD_CADENCE_MS = 12 * 60 * 60 * 1000;
export const ANNOUNCEMENT_MAX_VIEWS_MIN = 1;
export const ANNOUNCEMENT_MAX_VIEWS_MAX = 10;

export function hasRemainingViews(completedCount: number, maxViews: number): boolean {
  return completedCount < maxViews;
}

export function isOnboarded(user: {
  usernameIsSet: boolean;
  birthdate: Date | null;
  interests: string[];
  menOnlyConfirmed: boolean;
}): boolean {
  return Boolean(
    user.usernameIsSet && user.birthdate && user.interests.length >= 1 && user.menOnlyConfirmed,
  );
}

export function canSeeAds(user: { premium: boolean; premiumPlus: boolean } | null): boolean {
  if (!user) return true;
  return !(user.premium || user.premiumPlus);
}

export function isAudienceEligibleForAds(firstEligibleAt: Date, now: Date): boolean {
  return now.getTime() - firstEligibleAt.getTime() >= AD_CADENCE_MS;
}

export function isCadenceOpen(lastCompletedAt: Date | null, now: Date, cadenceMs: number): boolean {
  if (!lastCompletedAt) return true;
  return now.getTime() - lastCompletedAt.getTime() >= cadenceMs;
}

export function isAdCadenceOpen(lastCompletedAdAt: Date | null, now: Date): boolean {
  return isCadenceOpen(lastCompletedAdAt, now, AD_CADENCE_MS);
}

export function isAnnouncementCadenceOpen(lastCompletedAt: Date | null, now: Date): boolean {
  return isCadenceOpen(lastCompletedAt, now, ANNOUNCEMENT_CADENCE_MS);
}

/** Eligible items only: never-seen first (oldest published), else furthest-back completed. */
export function pickNextRotatingItem(
  items: Array<{ id: string; publishedAt: Date; lastCompletedAt: Date | null }>,
  now: Date,
  cadenceMs: number,
): string | null {
  const eligible = items.filter((item) => isCadenceOpen(item.lastCompletedAt, now, cadenceMs));
  if (eligible.length === 0) return null;
  const unseen = eligible
    .filter((item) => item.lastCompletedAt == null)
    .sort((a, b) => a.publishedAt.getTime() - b.publishedAt.getTime());
  if (unseen[0]) return unseen[0].id;

  const seen = [...eligible].sort((a, b) => {
    const aTime = a.lastCompletedAt?.getTime() ?? 0;
    const bTime = b.lastCompletedAt?.getTime() ?? 0;
    if (aTime !== bTime) return aTime - bTime;
    return a.publishedAt.getTime() - b.publishedAt.getTime();
  });
  return seen[0]?.id ?? null;
}

export function pickNextAnnouncement(
  items: Array<{ id: string; publishedAt: Date; lastCompletedAt: Date | null }>,
  now: Date,
): string | null {
  return pickNextRotatingItem(items, now, ANNOUNCEMENT_CADENCE_MS);
}

export function pickNextAd(
  ads: Array<{ id: string; publishedAt: Date; lastCompletedAt: Date | null }>,
  now: Date,
): string | null {
  return pickNextRotatingItem(ads, now, AD_CADENCE_MS);
}

export function viewerKeyFor(userId: string | null | undefined, anonymousId: string | null | undefined): string | null {
  if (userId) return `user:${userId}`;
  if (anonymousId) return `anon:${anonymousId}`;
  return null;
}
