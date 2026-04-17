import type { NotificationKind } from '@prisma/client';

export type NotificationActorDto = {
  id: string;
  username: string | null;
  name: string | null;
  avatarUrl: string | null;
  premium: boolean;
  isOrganization: boolean;
  verifiedStatus: string;
};

/** Preview of the subject post (e.g. boosted post) for display in the notification row. */
export type SubjectPostPreviewDto = {
  bodySnippet: string | null;
  media: Array<{ url: string; thumbnailUrl: string | null; kind: string }>;
};

/** Preview of the subject article for display in the notification row. */
export type SubjectArticlePreviewDto = {
  title: string | null;
  excerpt: string | null;
  thumbnailUrl: string | null;
  visibility: string | null;
};

export type SubjectPostVisibility = 'public' | 'verifiedOnly' | 'premiumOnly' | 'onlyMe';

/** Tier of the notification subject (post visibility or user tier) for unseen row highlight. */
export type SubjectTier = 'premium' | 'verified' | null;

export type NotificationDto = {
  id: string;
  createdAt: string;
  kind: NotificationKind;
  deliveredAt: string | null;
  readAt: string | null;
  ignoredAt: string | null;
  nudgedBackAt: string | null;
  actor: NotificationActorDto | null;
  /** The post that caused this notification (e.g. a reply or mention post). */
  actorPostId: string | null;
  subjectPostId: string | null;
  subjectUserId: string | null;
  subjectArticleId: string | null;
  subjectArticleCommentId: string | null;
  subjectGroupId: string | null;
  /** Slug of the subject group (only populated for group_join_request notifications). */
  subjectGroupSlug: string | null;
  /** Display name of the subject group (only populated for group_join_request notifications). */
  subjectGroupName: string | null;
  /** Crew this notification is about (set for any crew_* kind that has a real crew). */
  subjectCrewId: string | null;
  /**
   * Specific crew invite this notification refers to (crew_invite_received and related).
   * Lets the notification UI accept/decline the exact invite directly.
   */
  subjectCrewInviteId: string | null;
  /**
   * Current lifecycle status of `subjectCrewInviteId`, when present. Used so the
   * notification row can render the correct terminal state ("Joined crew",
   * "Declined", "No longer available") on a fresh load — without the FE having
   * to call /crew/invites/inbox just to figure out whether the invite is still
   * actionable.
   */
  subjectCrewInviteStatus: 'pending' | 'accepted' | 'declined' | 'cancelled' | 'expired' | null;
  /**
   * Display name for the crew this notification refers to, if known. For founding
   * invites (no crew yet) this falls back to the inviter's chosen
   * `CrewInvite.crewNameOnAccept`. Null when neither is set — the FE should render
   * "their crew" in that case.
   */
  subjectCrewName: string | null;
  title: string | null;
  body: string | null;
  /** When set (e.g. boost), for quote + stacked images / video thumbnail in the UI. */
  subjectPostPreview?: SubjectPostPreviewDto | null;
  /** When subject is an article (followed_article), article card preview. */
  subjectArticlePreview?: SubjectArticlePreviewDto | null;
  /** When subject is a post, its visibility (used for UI tinting). */
  subjectPostVisibility?: SubjectPostVisibility | null;
  /** Tier of subject (post or user) for unseen row highlight. */
  subjectTier: SubjectTier;
};
