import type { FollowVisibility, User, VerifiedStatus } from '@prisma/client';
import { publicAssetUrl } from '../assets/public-asset-url';

/** Relationship fields for list-user DTOs (follows, search). */
export type UserListRelationship = {
  viewerFollowsUser: boolean;
  userFollowsViewer: boolean;
};

/** Row shape accepted by toUserListDto (e.g. Prisma select or search result). */
export type UserListRow = {
  id: string;
  username: string | null;
  name: string | null;
  premium: boolean;
  premiumPlus: boolean;
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
  birthdate: string | null;
  interests: string[];
  menOnlyConfirmed: boolean;
  siteAdmin: boolean;
  premium: boolean;
  premiumPlus: boolean;
  stewardBadgeEnabled: boolean;
  verifiedStatus: VerifiedStatus;
  verifiedAt: string | null;
  unverifiedAt: string | null;
  followVisibility: FollowVisibility;
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
  stewardBadgeEnabled: boolean;
  verifiedStatus: string;
  avatarUrl: string | null;
  bannerUrl: string | null;
  lastOnlineAt: string | null;
  relationship: UserListRelationship;
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
    birthdate: user.birthdate ? user.birthdate.toISOString() : null,
    interests: user.interests ?? [],
    menOnlyConfirmed: Boolean(user.menOnlyConfirmed),
    siteAdmin: user.siteAdmin,
    premium: user.premium,
    premiumPlus: user.premiumPlus,
    stewardBadgeEnabled: Boolean(user.stewardBadgeEnabled),
    verifiedStatus: user.verifiedStatus,
    verifiedAt: user.verifiedAt ? user.verifiedAt.toISOString() : null,
    unverifiedAt: user.unverifiedAt ? user.unverifiedAt.toISOString() : null,
    followVisibility: user.followVisibility,
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
