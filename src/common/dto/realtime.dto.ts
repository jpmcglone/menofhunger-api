import type { MessageDto } from '../../modules/messages/message.dto';
import type { NotificationDto } from '../../modules/notifications/notification.dto';
import type { UserDto } from './user.dto';

/**
 * Websocket (Socket.IO) payload DTOs.
 *
 * These are shared contracts between:
 * - `menofhunger-api` realtime emitters (PresenceRealtimeService / PresenceGateway)
 * - `menofhunger-www` socket listeners (usePresence)
 */

export type NotificationsNewPayloadDto = {
  notification: NotificationDto;
};

export type NotificationsDeletedPayloadDto = {
  notificationIds: string[];
};

/**
 * Cross-device/tab sync for message read state.
 * (We currently emit to the reader's own sockets only.)
 */
export type MessagesReadPayloadDto = {
  conversationId: string;
  userId: string;
  lastReadAt: string; // ISO
};

/** Follow/unfollow changes (currently emitted to actor's own sockets only). */
export type FollowsChangedPayloadDto = {
  actorUserId: string;
  targetUserId: string;
  viewerFollowsUser: boolean;
};

export type PostInteractionKind = 'boost' | 'bookmark';

/** Post interaction updates (currently emitted to post author + actor). */
export type PostsInteractionPayloadDto = {
  postId: string;
  actorUserId: string;
  kind: PostInteractionKind;
  active: boolean;
  boostCount?: number;
  bookmarkCount?: number;
};

export type AdminUpdateKind = 'reports' | 'verification' | 'feedback';
export type AdminUpdateAction = 'created' | 'updated' | 'deleted' | 'resolved' | 'reviewed' | 'other';

/** Admin screen change hint for cross-tab sync (emitted to the acting admin's sockets). */
export type AdminUpdatedPayloadDto = {
  kind: AdminUpdateKind;
  action: AdminUpdateAction;
  id?: string;
};

/** Public profile payload (same shape as GET /users/:username). */
export type PublicProfileDto = {
  id: string;
  createdAt: string;
  username: string | null;
  name: string | null;
  bio: string | null;
  website: string | null;
  locationDisplay: string | null;
  locationCity: string | null;
  locationCounty: string | null;
  locationState: string | null;
  locationCountry: string | null;
  /** Birthday display string honoring the user's visibility setting. */
  birthdayDisplay: string | null;
  /** Month/day only (no year), e.g. "Jan 4". Null when unset. */
  birthdayMonthDay: string | null;
  premium: boolean;
  premiumPlus: boolean;
  isOrganization: boolean;
  stewardBadgeEnabled: boolean;
  verifiedStatus: string;
  avatarUrl: string | null;
  bannerUrl: string | null;
  pinnedPostId: string | null;
  lastOnlineAt: string | null;
};

/**
 * Public-profile updates (emitted to the user and their followers/related users).
 * Note: name says \"selfUpdated\" for backwards compatibility with initial plan; payload is public.
 */
export type UsersSelfUpdatedPayloadDto = {
  user: PublicProfileDto;
};

/**
 * Self-only auth/settings updates (emitted to the user's own sockets only).
 * Canonical payload matches `/auth/me` user shape.
 */
export type UsersMeUpdatedPayloadDto = {
  user: UserDto;
  /** Optional hint for debugging/UI refresh decisions. */
  reason?: string;
};

/**
 * Realtime message create (already emitted today, but typed here for completeness).
 * This remains `unknown` in the gateway; callers use `toMessageDto`.
 */
export type MessagesNewPayloadDto = {
  conversationId: string;
  message: MessageDto;
};

/**
 * Canonical websocket event ownership (to avoid double-dipping).
 *
 * - `users:meUpdated`: self-only account/auth/settings/gating snapshots (private `UserDto`)
 * - `users:selfUpdated`: public-profile projection fanout (public `PublicProfileDto`)
 * - `posts:*`: post/thread projections and scoped subscriptions (never used for user/account state)
 * - `messages:*`: chat projections only
 */
export const WsEventNames = {
  usersMeUpdated: 'users:meUpdated',
  usersSelfUpdated: 'users:selfUpdated',
  postsSubscribe: 'posts:subscribe',
  postsUnsubscribe: 'posts:unsubscribe',
  postsSubscribed: 'posts:subscribed',
  postsLiveUpdated: 'posts:liveUpdated',
} as const;

export type PostsSubscribePayloadDto = {
  postIds: string[];
};

export type PostsSubscribedPayloadDto = {
  postIds: string[];
};

/**
 * Minimal post patch for live updates.
 * NOTE: Keep this intentionally small; clients should treat unknown fields as best-effort.
 */
export type PostsLiveUpdatedPayloadDto = {
  postId: string;
  /** Monotonic-ish version (ISO timestamp string). Used for client-side stale checks. */
  version: string;
  reason: string;
  patch: Partial<{
    body: string;
    editedAt: string | null;
    editCount: number;
    deletedAt: string | null;
    commentCount: number;
  }>;
};

