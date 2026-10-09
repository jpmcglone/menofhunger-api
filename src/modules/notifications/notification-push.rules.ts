import type { NotificationKind } from '@prisma/client';
import type { NotificationPreferencesDto } from '../../common/dto';
import { sentenceCaseAction, withActionColon, SYSTEM_PUSH_KINDS, actionWithGroupName } from './notification-push.constants';

export function shouldSendPushForKind(
  prefs: Pick<
    NotificationPreferencesDto,
    | 'pushComment'
    | 'pushBoost'
    | 'pushFollow'
    | 'pushMention'
    | 'pushRepost'
    | 'pushNudge'
    | 'pushFollowedPost'
    | 'pushMessage'
    | 'pushGroupActivity'
    | 'pushDailyContent'
    | 'pushCheckinReminder'
  >,
  kind: NotificationKind,
): boolean {
  if (kind === 'comment') return Boolean(prefs.pushComment);
  if (kind === 'boost') return Boolean(prefs.pushBoost);
  if (kind === 'follow') return Boolean(prefs.pushFollow);
  if (kind === 'mention') return Boolean(prefs.pushMention);
  if (kind === 'repost') return Boolean(prefs.pushRepost);
  if (kind === 'nudge') return Boolean(prefs.pushNudge);
  if (kind === 'followed_post' || kind === 'checkin_post') return Boolean(prefs.pushFollowedPost);
  if (kind === 'followed_article') return Boolean(prefs.pushFollowedPost);
  if (kind === 'followed_space') return Boolean(prefs.pushFollowedPost);
  if (kind === 'status_update') return Boolean(prefs.pushFollowedPost);
  if (kind === 'message') return Boolean(prefs.pushMessage);
  if (
    kind === 'community_group_member_joined' ||
    kind === 'community_group_join_approved' ||
    kind === 'community_group_join_rejected' ||
    kind === 'community_group_member_removed' ||
    kind === 'community_group_disbanded' ||
    kind === 'group_join_request' ||
    kind === 'community_group_invite_received' ||
    kind === 'community_group_invite_accepted' ||
    kind === 'community_group_invite_declined' ||
    kind === 'community_group_invite_cancelled'
  ) return Boolean(prefs.pushGroupActivity);
  // marv_not_in_group is an informational notice, not an action the user needs to
  // act on urgently — skip push to avoid noise.
  if (kind === 'marv_not_in_group') return false;
  if (kind === 'word_of_the_day' || kind === 'quote_of_the_day' || kind === 'on_this_day')
    return Boolean(prefs.pushDailyContent);
  if (kind === 'checkin_reminder') return Boolean(prefs.pushCheckinReminder);
  // Non-mapped kinds pass through default (allow).
  return true;
}

/**
 * Lock-screen subtitle for APNs / web push.
 *
 * iOS Communication notifications (NSE + INSendMessageIntent) replace the alert
 * title with the actor's display name. The verb/context therefore lives here —
 * and is also folded into the body via `apnsBodyWithVisibleAction`, because the
 * Communication UI often omits subtitle on the lock screen.
 *
 * System kinds must not echo `fallbackTitle` as subtitle — that title already is
 * the bold first line (e.g. "Good morning" / "Good morning").
 */
export function pushSubtitle(
  kind: NotificationKind,
  groupName?: string | null,
  fallbackTitle?: string | null,
  subjectArticleId?: string | null,
): string | null {
  const group = (groupName ?? '').trim();
  if (SYSTEM_PUSH_KINDS.has(kind)) {
    return group || null;
  }

  const action = sentenceCaseAction(fallbackTitle ?? '');

  if (group && action) return withActionColon(actionWithGroupName(action, group));
  if (group) return group;
  if (action) return withActionColon(action);

  if (kind === 'comment') {
    return withActionColon(subjectArticleId ? 'Replied to your article' : 'Replied to your post');
  }
  if (kind === 'mention') {
    return withActionColon(subjectArticleId ? 'Mentioned you in an article' : 'Mentioned you');
  }
  if (kind === 'follow') return withActionColon('Followed you');
  if (kind === 'boost') {
    return withActionColon(subjectArticleId ? 'Boosted your article' : 'Boosted your post');
  }
  if (kind === 'repost') return withActionColon('Reposted your post');
  if (kind === 'followed_post') return withActionColon('Posted');
  if (kind === 'checkin_post') return withActionColon('Checked in');
  if (kind === 'status_update') return withActionColon('Updated their status');
  if (kind === 'nudge') return withActionColon('Nudged you');
  if (kind === 'followed_article') return withActionColon('Published an article');
  if (kind === 'message') return withActionColon('Sent you a message');
  return null;
}
