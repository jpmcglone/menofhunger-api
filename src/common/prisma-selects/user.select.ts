import type { Prisma } from '@prisma/client';

/**
 * Centralized Prisma selects for public user payloads.
 *
 * Why:
 * - Avoid `include: { user: true }` overfetch on hot paths (feeds/search/topics).
 * - Make it hard to regress: shared constants are reused across services/DTO mappers.
 */
export const ORG_AFFILIATION_SELECT = {
  id: true,
  username: true,
  name: true,
  avatarKey: true,
  avatarVideoKey: true,
  avatarVideoDurationMs: true,
  avatarUpdatedAt: true,
} as const;

export const USER_LIST_SELECT = {
  id: true,
  username: true,
  name: true,
  premium: true,
  premiumPlus: true,
  isOrganization: true,
  accountKind: true,
  verifiedStatus: true,
  avatarKey: true,
  avatarVideoKey: true,
  avatarVideoDurationMs: true,
  avatarUpdatedAt: true,
  bannedAt: true,
  isBot: true,
  createdAt: true,
  orgMemberships: {
    select: {
      org: { select: ORG_AFFILIATION_SELECT },
    },
    orderBy: { createdAt: "asc" as const },
  },
} as const;

/** Message thread participants: list fields without org affiliations or account kind. */
export const MESSAGE_PARTICIPANT_USER_SELECT = {
  id: true,
  username: true,
  name: true,
  premium: true,
  premiumPlus: true,
  isOrganization: true,
  verifiedStatus: true,
  avatarKey: true,
  avatarVideoKey: true,
  avatarVideoDurationMs: true,
  avatarUpdatedAt: true,
  bannedAt: true,
  isBot: true,
} as const;

/**
 * Mention payloads are rendered inline; keep this minimal but include tier fields.
 */
export const MENTION_USER_SELECT = {
  id: true,
  username: true,
  verifiedStatus: true,
  premium: true,
  premiumPlus: true,
  isOrganization: true,
} as const;

/** Select shape for `toUserDto` (auth/me). Keep explicit so future columns don't get auto-exposed. */
export const USER_DTO_SELECT = {
  id: true,
  createdAt: true,
  phone: true,
  accountKind: true,
  email: true,
  emailVerifiedAt: true,
  emailVerificationRequestedAt: true,
  username: true,
  usernameIsSet: true,
  name: true,
  bio: true,
  website: true,
  xUsername: true,
  pickaxUsername: true,
  rumbleUrl: true,
  linkedinUrl: true,
  youtubeUrl: true,
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
  heardAboutUs: true,
  heardAboutUsOther: true,
  recruitedById: true,
  siteAdmin: true,
  featureToggles: true,
  bannedAt: true,
  bannedReason: true,
  bannedByAdminId: true,
  premium: true,
  premiumPlus: true,
  isOrganization: true,
  verifiedStatus: true,
  verifiedAt: true,
  unverifiedAt: true,
  followVisibility: true,
  birthdayVisibility: true,
  avatarKey: true,
  avatarVideoKey: true,
  avatarVideoDurationMs: true,
  avatarUpdatedAt: true,
  bannerKey: true,
  bannerUpdatedAt: true,
  pinnedPostId: true,
  coins: true,
  checkinStreakDays: true,
  lastCheckinDayKey: true,
  longestStreakDays: true,
  locationPromptSkipped: true,
  openToCrewAt: true,
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

/** Minimal user reference: id + handle. */
export const USER_REF_SELECT = {
  id: true,
  username: true,
} as const satisfies Prisma.UserSelect;

/** Brief user summary: id, handle, display name. */
export const USER_BRIEF_SELECT = {
  id: true,
  username: true,
  name: true,
} as const satisfies Prisma.UserSelect;

/** Avatar fields shared by every payload that renders a user avatar. */
export const USER_AVATAR_SELECT = {
  avatarKey: true,
  avatarVideoKey: true,
  avatarVideoDurationMs: true,
  avatarUpdatedAt: true,
} as const satisfies Prisma.UserSelect;

/** User reference with avatar media. */
export const USER_AVATAR_BRIEF_SELECT = {
  id: true,
  username: true,
  ...USER_AVATAR_SELECT,
} as const satisfies Prisma.UserSelect;

/** Nested relation select: `user: userSelect(USER_BRIEF_SELECT)` -> `{ select: ... }`. */
export function selectUser<S extends Prisma.UserSelect>(select: S): { select: S } {
  return { select };
}
