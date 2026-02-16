import type { BirthdayVisibility, FollowVisibility, User, VerifiedStatus } from '@prisma/client';
import { publicAssetUrl } from '../assets/public-asset-url';

/** Relationship fields for list-user DTOs (follows, search). */
export type UserListRelationship = {
  viewerFollowsUser: boolean;
  userFollowsViewer: boolean;
  /** True when the viewer has enabled “every post” notifications (bell icon) for this follow. */
  viewerPostNotificationsEnabled: boolean;
};

export type NudgeStateDto = {
  /**
   * True when the viewer is currently blocked from nudging this user.
   *
   * Blocked when the viewer has nudged this user within the last 24h and neither:
   * - the other user nudged back, nor
   * - the other user acknowledged it via “Got it” (readAt set without ignoredAt).
   *
   * Note: “Ignore” does NOT clear the block (ignoredAt is persisted to keep the sender rate-limited).
   */
  outboundPending: boolean;
  /** True when this user has an unread inbound nudge to the viewer (within the expiry window). */
  inboundPending: boolean;
  /** Latest unread inbound nudge notification ID (for “Got it” / acknowledge, or “Nudge back”). */
  inboundNotificationId: string | null;
  /** When the outbound nudge block expires (ISO string), if any. */
  outboundExpiresAt: string | null;
};

/** Row shape accepted by toUserListDto (e.g. Prisma select or search result). */
export type UserListRow = {
  id: string;
  username: string | null;
  name: string | null;
  premium: boolean;
  premiumPlus: boolean;
  isOrganization: boolean;
  stewardBadgeEnabled: boolean;
  verifiedStatus: string;
  avatarKey: string | null;
  avatarUpdatedAt: Date | null;
  createdAt?: Date;
};

/** List-user DTO (follow lists, search users). Optional relationship and createdAt. */
export type UserListDto = {
  id: string;
  username: string | null;
  name: string | null;
  premium: boolean;
  premiumPlus: boolean;
  isOrganization: boolean;
  stewardBadgeEnabled: boolean;
  verifiedStatus: string;
  avatarUrl: string | null;
  relationship?: UserListRelationship;
  createdAt?: string;
};

export function toUserListDto(
  row: UserListRow,
  publicBaseUrl: string | null,
  opts?: { relationship?: UserListRelationship; createdAt?: Date },
): UserListDto {
  const dto: UserListDto = {
    id: row.id,
    username: row.username,
    name: row.name,
    premium: row.premium,
    premiumPlus: row.premiumPlus,
    isOrganization: Boolean(row.isOrganization),
    stewardBadgeEnabled: Boolean(row.stewardBadgeEnabled),
    verifiedStatus: row.verifiedStatus,
    avatarUrl: publicAssetUrl({
      publicBaseUrl,
      key: row.avatarKey ?? null,
      updatedAt: row.avatarUpdatedAt ?? null,
    }),
  };
  if (opts?.relationship) dto.relationship = opts.relationship;
  if (opts?.createdAt !== undefined) dto.createdAt = opts.createdAt.toISOString();
  else if (row.createdAt) dto.createdAt = row.createdAt.toISOString();
  return dto;
}

export type UserDto = {
  id: string;
  createdAt: string;
  phone: string;
  email: string | null;
  username: string | null;
  usernameIsSet: boolean;
  name: string | null;
  bio: string | null;
  website: string | null;
  locationInput: string | null;
  locationDisplay: string | null;
  locationZip: string | null;
  locationCity: string | null;
  locationCounty: string | null;
  locationState: string | null;
  locationCountry: string | null;
  birthdate: string | null;
  interests: string[];
  menOnlyConfirmed: boolean;
  siteAdmin: boolean;
  premium: boolean;
  premiumPlus: boolean;
  isOrganization: boolean;
  stewardBadgeEnabled: boolean;
  verifiedStatus: VerifiedStatus;
  verifiedAt: string | null;
  unverifiedAt: string | null;
  followVisibility: FollowVisibility;
  birthdayVisibility: BirthdayVisibility;
  avatarUrl: string | null;
  bannerUrl: string | null;
  pinnedPostId: string | null;
};

export type UserPreviewDto = {
  id: string;
  username: string | null;
  name: string | null;
  bio: string | null;
  premium: boolean;
  premiumPlus: boolean;
  isOrganization: boolean;
  stewardBadgeEnabled: boolean;
  verifiedStatus: string;
  avatarUrl: string | null;
  bannerUrl: string | null;
  lastOnlineAt: string | null;
  relationship: UserListRelationship;
  nudge: NudgeStateDto | null;
  followerCount: number | null;
  followingCount: number | null;
};

export function toUserDto(user: User, publicAssetBaseUrl: string | null = null): UserDto {
  return {
    id: user.id,
    createdAt: user.createdAt.toISOString(),
    phone: user.phone,
    email: user.email ?? null,
    username: user.username,
    usernameIsSet: user.usernameIsSet,
    name: user.name,
    bio: user.bio,
    website: (user as any).website ?? null,
    locationInput: (user as any).locationInput ?? null,
    locationDisplay: (user as any).locationDisplay ?? null,
    locationZip: (user as any).locationZip ?? null,
    locationCity: (user as any).locationCity ?? null,
    locationCounty: (user as any).locationCounty ?? null,
    locationState: (user as any).locationState ?? null,
    locationCountry: (user as any).locationCountry ?? null,
    birthdate: user.birthdate ? user.birthdate.toISOString() : null,
    interests: user.interests ?? [],
    menOnlyConfirmed: Boolean(user.menOnlyConfirmed),
    siteAdmin: user.siteAdmin,
    premium: user.premium,
    premiumPlus: user.premiumPlus,
    isOrganization: Boolean((user as any).isOrganization),
    stewardBadgeEnabled: Boolean(user.stewardBadgeEnabled),
    verifiedStatus: user.verifiedStatus,
    verifiedAt: user.verifiedAt ? user.verifiedAt.toISOString() : null,
    unverifiedAt: user.unverifiedAt ? user.unverifiedAt.toISOString() : null,
    followVisibility: user.followVisibility,
    birthdayVisibility: (user as any).birthdayVisibility ?? 'monthDay',
    avatarUrl: publicAssetUrl({
      publicBaseUrl: publicAssetBaseUrl,
      key: user.avatarKey ?? null,
      updatedAt: user.avatarUpdatedAt ?? null,
    }),
    bannerUrl: publicAssetUrl({
      publicBaseUrl: publicAssetBaseUrl,
      key: user.bannerKey ?? null,
      updatedAt: user.bannerUpdatedAt ?? null,
    }),
    pinnedPostId: user.pinnedPostId ?? null,
  };
}
