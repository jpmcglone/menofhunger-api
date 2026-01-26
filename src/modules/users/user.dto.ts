import type { User, VerifiedStatus } from '@prisma/client';

export type UserDto = {
  id: string;
  createdAt: string;
  phone: string;
  username: string | null;
  usernameIsSet: boolean;
  name: string | null;
  bio: string | null;
  siteAdmin: boolean;
  verifiedStatus: VerifiedStatus;
  verifiedAt: string | null;
  unverifiedAt: string | null;
  avatarKey: string | null;
  avatarUpdatedAt: string | null;
};

export function toUserDto(user: User): UserDto {
  return {
    id: user.id,
    createdAt: user.createdAt.toISOString(),
    phone: user.phone,
    username: user.username,
    usernameIsSet: user.usernameIsSet,
    name: user.name,
    bio: user.bio,
    siteAdmin: user.siteAdmin,
    verifiedStatus: user.verifiedStatus,
    verifiedAt: user.verifiedAt ? user.verifiedAt.toISOString() : null,
    unverifiedAt: user.unverifiedAt ? user.unverifiedAt.toISOString() : null,
    avatarKey: user.avatarKey ?? null,
    avatarUpdatedAt: user.avatarUpdatedAt ? user.avatarUpdatedAt.toISOString() : null,
  };
}

