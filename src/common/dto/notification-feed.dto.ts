import type { NotificationActorDto, NotificationDto, SubjectPostPreviewDto, SubjectPostVisibility, SubjectTier } from '../../modules/notifications/notification.dto';

export type NotificationGroupKind = 'comment' | 'boost' | 'follow' | 'followed_post' | 'nudge';

/**
 * A conservative grouped notification row built from strictly consecutive notifications.
 * `id` is the newest notification id in the group (stable key for rendering).
 */
export type NotificationGroupDto = {
  id: string;
  kind: NotificationGroupKind;
  createdAt: string;
  deliveredAt: string | null;
  readAt: string | null;

  /** Navigation subject when applicable. */
  subjectPostId: string | null;
  subjectUserId: string | null;

  /** Unique actors in newest->oldest order (max not enforced by API). */
  actors: NotificationActorDto[];
  actorCount: number;

  /** Number of underlying notifications represented by this group. */
  count: number;

  /** Latest body snippet (used for comment groups). */
  latestBody: string | null;

  /** Latest subject post preview (used for post-subject groups). */
  latestSubjectPostPreview: SubjectPostPreviewDto | null;

  /** When subject is a post, its visibility (used for UI tinting). */
  subjectPostVisibility: SubjectPostVisibility | null;

  /** Tier of subject (post or user) for unseen row highlight. */
  subjectTier: SubjectTier;
};

/**
 * Collapsed “new posts” row for followed-post notifications when bell is NOT enabled.
 * This is a UI affordance only; underlying notifications still exist for counts and read semantics.
 */
export type FollowedPostsRollupDto = {
  /** The newest underlying notification id (stable-ish render key). */
  id: string;
  createdAt: string;
  deliveredAt: string | null;
  readAt: string | null;
  /** Unique actors with new posts (newest->oldest). */
  actors: NotificationActorDto[];
  actorCount: number;
  /** Number of underlying followed-post notifications represented by this rollup. */
  count: number;
};

export type NotificationFeedItemDto =
  | { type: 'single'; notification: NotificationDto }
  | { type: 'group'; group: NotificationGroupDto }
  | { type: 'followed_posts_rollup'; rollup: FollowedPostsRollupDto };

