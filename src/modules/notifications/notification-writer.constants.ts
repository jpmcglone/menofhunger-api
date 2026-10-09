import { type NotificationKind } from "@prisma/client";

/** Kinds that announce the actor's own post/publish. Operators of a page actor already did the action. */
export const ACTOR_SELF_ECHO_KINDS = new Set<NotificationKind>([
  "followed_article",
  "checkin_post",
  "status_update",
]);

/**
 * Post-shaped kinds that all render as the same PostRow for a given causing post.
 * At most one of these should exist per (recipient, causing post) — a retry or a
 * comment+followed_post skip hole must not double-buzz the same reply.
 */
export const POST_CAUSED_KINDS: NotificationKind[] = [
  "comment",
  "mention",
  "followed_post",
  "checkin_post",
];
export const POST_CAUSED_KIND_SET = new Set<NotificationKind>(POST_CAUSED_KINDS);

export type CreateNotificationParams = {
  id?: string;
  actionPath?: string;
  recipientUserId: string;
  kind: NotificationKind;
  actorUserId?: string | null;
  actorPostId?: string | null;
  subjectPostId?: string | null;
  subjectUserId?: string | null;
  subjectArticleId?: string | null;
  subjectArticleCommentId?: string | null;
  subjectGroupId?: string | null;
  subjectCrewId?: string | null;
  subjectCrewInviteId?: string | null;
  subjectCommunityGroupInviteId?: string | null;
  subjectConversationId?: string | null;
  subjectSpaceId?: string | null;
  title?: string | null;
  body?: string | null;
};
