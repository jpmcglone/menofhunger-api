import type { UserListDto } from './user.dto';

export type UserStatusDto = {
  userId: string;
  text: string;
  setAt: string;
  expiresAt: string;
  /** ID of the `kind: 'status'` post created when `createsPost` was true. Null when no post was generated. */
  postId: string | null;
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
  /**
   * Deduped list of client platforms this user is currently connected from,
   * ordered by most-recent connection (e.g. ['ios', 'web']). Empty when the user
   * is tracked only via Redis and the in-memory service has no sockets on this instance.
   */
  platforms?: string[];
  /** Currently holds a seat in a voice/video call (any type). Kept live by `presence:call-changed`. */
  inCall?: boolean;
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

export type OnlinePaginationDto = {
  totalOnline: number;
  /**
   * Count of users who were online within the last hour but are not currently
   * online (excludes everyone already counted in `totalOnline`). Powers the
   * "(N more recently)" hint next to the online count in the right rail.
   */
  recentlyOnlineCount: number;
  /**
   * Unique logged-out visitors with a live socket right now. Distinct from
   * `totalOnline` (signed-in members). Hidden in the UI when zero.
   */
  anonymousOnline: number;
  /**
   * Tier breakdown of `data` (always computed, including for `?summary=1`
   * where `data` is empty). Powers the right-rail hover popover.
   */
  premiumPlus?: number;
  premium?: number;
  verified?: number;
  unverified?: number;
};

export type PresenceOnlinePageDto = {
  online: OnlineUserDto[];
  recent: RecentlyOnlineUserDto[];
};

export type PresenceOnlinePagePaginationDto = {
  totalOnline: number;
  /** Unique logged-out visitors with a live socket. Hidden in the UI when zero. */
  anonymousOnline: number;
  recentNextCursor: string | null;
};

