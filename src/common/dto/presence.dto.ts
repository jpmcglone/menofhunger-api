import type { UserListDto } from './user.dto';

export type UserStatusDto = {
  userId: string;
  text: string;
  setAt: string;
  expiresAt: string;
};

export type OnlineUserDto = UserListDto & {
  lastConnectAt: number | null;
  idle: boolean;
  status?: UserStatusDto | null;
  /**
   * True when this row is a synthetic bot pin (Marv) rather than a real Redis-tracked
   * online user. Frontend uses this to sort bots to the top of the list and decorate
   * the row with a small "bot" badge.
   */
  isBot?: boolean;
};

export type RecentlyOnlineUserDto = UserListDto & {
  // Presence "recently online" is always rendered as a follow-list row, so relationship is always present.
  relationship: NonNullable<UserListDto['relationship']>;
  lastOnlineAt: string | null;
  status?: UserStatusDto | null;
};

export type RecentlyOnlinePaginationDto = {
  nextCursor: string | null;
};

export type PresenceOnlinePageDto = {
  online: OnlineUserDto[];
  recent: RecentlyOnlineUserDto[];
};

export type PresenceOnlinePagePaginationDto = {
  totalOnline: number;
  recentNextCursor: string | null;
};

