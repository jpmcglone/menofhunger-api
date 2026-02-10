import type { UserListDto } from './user.dto';

export type RecentlyOnlineUserDto = UserListDto & {
  // Presence "recently online" is always rendered as a follow-list row, so relationship is always present.
  relationship: NonNullable<UserListDto['relationship']>;
  lastOnlineAt: string | null;
};

export type RecentlyOnlinePaginationDto = {
  nextCursor: string | null;
};

