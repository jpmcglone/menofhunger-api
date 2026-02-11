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

export type NotificationFeedItemDto =
  | { type: 'single'; notification: NotificationDto }
  | { type: 'group'; group: NotificationGroupDto };

