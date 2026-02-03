import type { NotificationKind } from '@prisma/client';

export type NotificationActorDto = {
  id: string;
  username: string | null;
  name: string | null;
  avatarUrl: string | null;
  premium: boolean;
  verifiedStatus: string;
};

/** Preview of the subject post (e.g. boosted post) for display in the notification row. */
export type SubjectPostPreviewDto = {
  bodySnippet: string | null;
  media: Array<{ url: string; thumbnailUrl: string | null; kind: string }>;
};

/** Tier of the notification subject (post visibility or user tier) for unseen row highlight. */
export type SubjectTier = 'premium' | 'verified' | null;

export type NotificationDto = {
  id: string;
  createdAt: string;
  kind: NotificationKind;
  deliveredAt: string | null;
  readAt: string | null;
  actor: NotificationActorDto | null;
  subjectPostId: string | null;
  subjectUserId: string | null;
  title: string | null;
  body: string | null;
  /** When set (e.g. boost), for quote + stacked images / video thumbnail in the UI. */
  subjectPostPreview?: SubjectPostPreviewDto | null;
  /** Tier of subject (post or user) for unseen row highlight. */
  subjectTier: SubjectTier;
};
