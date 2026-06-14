import type { VerifiedStatus } from '@prisma/client';
import type { MessageDto } from '../../modules/messages/message.dto';
import type { NotificationDto } from '../../modules/notifications/notification.dto';
import type { UserDto } from './user.dto';
import type { ArticleCommentDto, ArticleReactionSummaryDto } from './article.dto';
import type { PostDto, PostPollDto } from './post.dto';
import type { UserStatusDto } from './presence.dto';
import type { ScheduledPostDto } from './scheduled-post.dto';

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
  locationZip: string | null;
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
  verifiedStatus: VerifiedStatus;
  avatarUrl: string | null;
  bannerUrl: string | null;
  pinnedPostId: string | null;
  lastOnlineAt: string | null;
  checkinStreakDays: number;
  longestStreakDays: number;
  /** True when this user is an active member of any Crew. */
  inCrew?: boolean;
  isBot?: boolean;
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
  /** Full user snapshot for profile/auth state updates. Optional for hint-only emits. */
  user?: UserDto;
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
/** Emitted to subscribers of a user when that user joins or leaves a space. */
export type UsersSpaceChangedPayloadDto = {
  userId: string;
  spaceId: string | null;
  previousSpaceId?: string;
};

export type PresenceStatusUpdatedPayloadDto = {
  status: UserStatusDto;
};

export type PresenceStatusClearedPayloadDto = {
  userId: string;
};

export const WsEventNames = {
  scheduledPostPublished: 'scheduled:published',
  scheduledPostFailed: 'scheduled:failed',
  usersMeUpdated: 'users:meUpdated',
  usersSelfUpdated: 'users:selfUpdated',
  usersSpaceChanged: 'users:spaceChanged',
  presenceStatusUpdated: 'presence:status-updated',
  presenceStatusCleared: 'presence:status-cleared',
  postsSubscribe: 'posts:subscribe',
  postsUnsubscribe: 'posts:unsubscribe',
  postsSubscribed: 'posts:subscribed',
  postsLiveUpdated: 'posts:liveUpdated',
  postsCommentAdded: 'posts:commentAdded',
  postsCommentDeleted: 'posts:commentDeleted',
  postsTyping: 'posts:typing',
  /** New top-level post from someone the viewer follows; pushed to follower user rooms. */
  feedNewPost: 'feed:newPost',
  /** Room subscription handshake for community-group feeds. */
  groupsSubscribe: 'groups:subscribe',
  groupsUnsubscribe: 'groups:unsubscribe',
  groupsSubscribed: 'groups:subscribed',
  /** New top-level post (or repost) in a community group; pushed to the `group:{id}` room. */
  groupsNewPost: 'groups:newPost',
  articlesSubscribe: 'articles:subscribe',
  articlesUnsubscribe: 'articles:unsubscribe',
  articlesSubscribed: 'articles:subscribed',
  articlesLiveUpdated: 'articles:liveUpdated',
  articlesCommentAdded: 'articles:commentAdded',
  articlesCommentDeleted: 'articles:commentDeleted',
  articlesCommentUpdated: 'articles:commentUpdated',
  articlesCommentReactionChanged: 'articles:commentReactionChanged',
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
 *
 * `posts:liveUpdated` is emitted to the `post:{id}` room, so every viewer
 * subscribed to the post sees count/body/delete updates in real time. This is
 * the correct channel for any change a third-party viewer needs to see; the
 * narrower `posts:interaction` event is reserved for actor + post author
 * (so they can reconcile their own viewerHas* flags).
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
    viewerCount: number;
    boostCount: number;
    bookmarkCount: number;
    repostCount: number;
    /** Updated poll state (vote counts + viewer flags) after a vote is cast. */
    poll: PostPollDto | null;
  }>;
};

/** Client → server: subscribe to live updates for one or more community-group feeds. */
export type GroupsSubscribePayloadDto = {
  groupIds: string[];
};

/** Server → client ack listing the group ids the socket was actually subscribed to. */
export type GroupsSubscribedPayloadDto = {
  groupIds: string[];
};

/**
 * New top-level post (or flat repost) created inside a community group.
 * Emitted to the `group:{groupId}` room so members viewing the group feed can prepend
 * it in real time. Payload mirrors the HTTP feed shape (`PostDto`) so the client can
 * splice it into its in-memory list without a refetch.
 */
export type GroupNewPostPayloadDto = {
  groupId: string;
  post: PostDto;
};

export type ArticlesSubscribePayloadDto = {
  articleIds: string[];
};

export type ArticlesSubscribedPayloadDto = {
  articleIds: string[];
};

/**
 * Minimal article patch for live updates.
 * NOTE: Keep this intentionally small; clients should treat unknown fields as best-effort.
 */
export type ArticlesLiveUpdatedPayloadDto = {
  articleId: string;
  /** Monotonic-ish version (ISO timestamp string). Used for client-side stale checks. */
  version: string;
  reason: string;
  patch: Partial<{
    commentCount: number;
    viewCount: number;
    boostCount: number;
    reactions: ArticleReactionSummaryDto[];
  }>;
};

export type ArticlesCommentAddedPayloadDto = {
  articleId: string;
  comment: ArticleCommentDto;
};

export type ArticlesCommentDeletedPayloadDto = {
  articleId: string;
  commentId: string;
  parentId: string | null;
};

export type ArticlesCommentUpdatedPayloadDto = {
  articleId: string;
  comment: ArticleCommentDto;
};

export type ArticlesCommentReactionChangedPayloadDto = {
  articleId: string;
  commentId: string;
  parentId: string | null;
  reactions: ArticleReactionSummaryDto[];
};

/** Full reply DTO pushed to `post:{parentPostId}` room subscribers when a new reply is created. */
export type PostsCommentAddedPayloadDto = {
  parentPostId: string;
  comment: PostDto;
};

/**
 * New top-level post from someone the viewer follows.
 * Emitted to each eligible follower's `user:{followerId}` room so their home feed can
 * prepend the post in real time without polling.
 */
export type FeedNewPostPayloadDto = {
  post: PostDto;
};

/** Minimal delete hint pushed to `post:{parentPostId}` room subscribers when a reply is soft-deleted. */
export type PostsCommentDeletedPayloadDto = {
  parentPostId: string;
  commentId: string;
};

/**
 * Live "someone is replying to this post" indicator.
 * Emitted to `post:{postId}` room subscribers (excluding the sender) while a user is composing a reply.
 * Mirrors the shape of `messages:typing` / `spaces:typing` — no state persisted server-side.
 *
 * `status` is only set by server-side emitters (e.g. Marvin):
 *   - `'thinking'` — AI is processing (show purple "thinking" label)
 *   - `'replying'` — about to post the reply (show standard wave animation)
 */
export type PostsTypingPayloadDto = {
  postId: string;
  user: {
    id: string;
    username: string | null;
    verifiedStatus: string | null;
    premium: boolean;
    premiumPlus: boolean;
    isOrganization: boolean;
  };
  typing: boolean;
  status?: 'thinking' | 'replying';
};

/**
 * Crew streak realtime payloads (Phase 3 — DAU loop).
 *
 * Both events are fanned out to every member of the crew. Receivers use them to
 * celebrate the advance in-place or learn who broke the streak (the latter is
 * intentionally specific — generic "streak broke" without names is cheap to
 * ignore; named accountability is the behavioral nudge).
 */
export type CrewStreakAdvancedPayloadDto = {
  crewId: string;
  /** ET YYYY-MM-DD on which all members locked in. */
  dayKey: string;
  currentStreakDays: number;
  longestStreakDays: number;
};

export type CrewStreakBrokenPayloadDto = {
  crewId: string;
  /** ET YYYY-MM-DD that was missed (i.e. yesterday at the moment the cron ran). */
  missedDayKey: string;
  /** Member identities who failed to check in on missedDayKey. */
  missedMembers: Array<{
    id: string;
    username: string | null;
    displayName: string | null;
  }>;
};

/**
 * Live "someone in your circle just answered today's question" event.
 * Emitted to the actor's followers + crew members when a `kind: 'checkin'` post is created.
 * Carries the actor identity (so receivers can prepend a face) and the new global total.
 */
export type CheckinAnsweredTodayPayloadDto = {
  dayKey: string;
  totalToday: number;
  answerer: {
    id: string;
    username: string | null;
    displayName: string | null;
    avatarUrl: string | null;
    isFollowed?: boolean;
  };
};

/** Referral recruit updated (emitted to the recruiter when a recruit reaches a milestone). */
export type ReferralRecruitUpdatedPayloadDto = {
  recruit: import('./referral.dto').RecruitDto;
};

/**
 * Emitted to the post owner when a scheduled post is auto-published by the cron sweep.
 * Allows the /scheduled page to remove the holding row and optionally prepend the live post.
 */
export type ScheduledPostPublishedPayloadDto = {
  /** The id of the holding row that was published (now deleted). */
  scheduledId: string;
  /** The new live post. */
  post: PostDto;
};

/**
 * Emitted to the post owner when a scheduled post fails to publish.
 * The /scheduled page should refresh to show the error state.
 */
export type ScheduledPostFailedPayloadDto = {
  scheduledId: string;
  error: string;
};

// Re-export for convenience.
export type { ScheduledPostDto };

