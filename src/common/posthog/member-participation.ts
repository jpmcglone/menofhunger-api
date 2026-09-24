import type { PosthogService } from './posthog.service';

/** Call only for a committed, published post. IDs are for deduplication, never post content. */
export function captureMemberParticipation(
  analytics: Pick<PosthogService, 'capture'>,
  post: { id: string; userId: string; kind: string; visibility: string; isBot: boolean; verifiedStatus: string; parentId?: string | null; parentAuthorId?: string | null; parentIsBot?: boolean },
): void {
  if (post.isBot || post.verifiedStatus === 'none' || post.visibility === 'onlyMe' || !['regular', 'checkin'].includes(post.kind)) return;
  analytics.capture(post.userId, 'member_contributed', {
    $insert_id: `contribution:${post.id}`, kind: post.kind, is_reply: Boolean(post.parentId),
    verified_status: post.verifiedStatus,
  });
  if (post.parentAuthorId && post.parentAuthorId !== post.userId && !post.parentIsBot) {
    analytics.capture(post.userId, 'member_replied', { $insert_id: `reply:${post.id}` });
    analytics.capture(post.parentAuthorId, 'member_received_reply', { $insert_id: `received-reply:${post.id}` });
  }
}
