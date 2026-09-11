import type { NotificationKind } from '@prisma/client';

/** Inbox + push click-throughs that should open `/a/:id` instead of a post or profile. */
export const ARTICLE_NOTIFICATION_CLICK_KINDS = new Set<NotificationKind>([
  'comment',
  'mention',
  'followed_article',
  'boost',
  'generic',
]);

/** Path the iOS/web clients open for an article notification. Hash matches permalinks. */
export function articleNotificationClickPath(
  subjectArticleId?: string | null,
  subjectArticleCommentId?: string | null,
): string | null {
  const articleId = (subjectArticleId ?? '').trim();
  if (!articleId) return null;
  const commentId = (subjectArticleCommentId ?? '').trim();
  return commentId ? `/a/${articleId}#comment-${commentId}` : `/a/${articleId}`;
}
