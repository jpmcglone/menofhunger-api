/**
 * Centralized Prisma selects for public user payloads.
 *
 * Why:
 * - Avoid `include: { user: true }` overfetch on hot paths (feeds/search/topics).
 * - Make it hard to regress: shared constants are reused across services/DTO mappers.
 */
export const USER_LIST_SELECT = {
  id: true,
  username: true,
  name: true,
  premium: true,
  premiumPlus: true,
  isOrganization: true,
  stewardBadgeEnabled: true,
  verifiedStatus: true,
  avatarKey: true,
  avatarUpdatedAt: true,
} as const;

/**
 * Mention payloads are rendered inline; keep this minimal but include tier/badge fields.
 * (Some older callsites only used `premium`/`verifiedStatus`; newer UI wants the full badge set.)
 */
export const MENTION_USER_SELECT = {
  id: true,
  username: true,
  verifiedStatus: true,
  premium: true,
  premiumPlus: true,
  isOrganization: true,
  stewardBadgeEnabled: true,
} as const;

/** Select shape for `toUserDto` (auth/me). Keep explicit so future columns don't get auto-exposed. */
export const USER_DTO_SELECT = {
  id: true,
  createdAt: true,
  phone: true,
  email: true,
  emailVerifiedAt: true,
  emailVerificationRequestedAt: true,
  username: true,
  usernameIsSet: true,
  name: true,
  bio: true,
  website: true,
  locationInput: true,
  locationDisplay: true,
  locationZip: true,
  locationCity: true,
  locationCounty: true,
  locationState: true,
  locationCountry: true,
  birthdate: true,
  interests: true,
  menOnlyConfirmed: true,
  siteAdmin: true,
  bannedAt: true,
  bannedReason: true,
  bannedByAdminId: true,
  premium: true,
  premiumPlus: true,
  isOrganization: true,
  stewardBadgeEnabled: true,
  verifiedStatus: true,
  verifiedAt: true,
  unverifiedAt: true,
  followVisibility: true,
  birthdayVisibility: true,
  avatarKey: true,
  avatarUpdatedAt: true,
  bannerKey: true,
  bannerUpdatedAt: true,
  pinnedPostId: true,
  coins: true,
  checkinStreakDays: true,
  lastCheckinDayKey: true,
  longestStreakDays: true,
} as const;

/** Select shape used for verification admin DTO user summary. */
export const VERIFICATION_ADMIN_USER_SELECT = {
  id: true,
  createdAt: true,
  phone: true,
  email: true,
  username: true,
  usernameIsSet: true,
  name: true,
  siteAdmin: true,
  premium: true,
  premiumPlus: true,
  verifiedStatus: true,
  verifiedAt: true,
  unverifiedAt: true,
} as const;

