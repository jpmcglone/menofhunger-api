import type { FollowVisibility, User, VerifiedStatus } from '@prisma/client';
import { publicAssetUrl } from '../../common/assets/public-asset-url';

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
  verifiedStatus: VerifiedStatus;
  verifiedAt: string | null;
  unverifiedAt: string | null;
  followVisibility: FollowVisibility;
  avatarUrl: string | null;
  bannerUrl: string | null;
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
  };
}

