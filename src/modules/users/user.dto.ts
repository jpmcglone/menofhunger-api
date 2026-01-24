import type { User } from '@prisma/client';

export type UserDto = {
  id: string;
  phone: string;
  username: string | null;
  usernameIsSet: boolean;
  name: string | null;
  bio: string | null;
};

export function toUserDto(user: User): UserDto {
  return {
    id: user.id,
    phone: user.phone,
    username: user.username,
    usernameIsSet: user.usernameIsSet,
    name: user.name,
    bio: user.bio,
  };
}

