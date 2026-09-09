import type { NotificationKind, Prisma } from '@prisma/client';

import type { NotificationCategory, NotificationUnreadByCategory } from './notification.dto';

const CATEGORIZED_KINDS: NotificationKind[] = [
  'followed_post', 'checkin_post', 'community_group_post', 'comment',
  'mention', 'crew_wall_mention', 'status_update', 'follow', 'boost',
];

/** Event identity wins over post shape: a mention in a reply is a mention. */
export function notificationCategory(kind: string, parentId?: string | null): NotificationCategory {
  switch (kind) {
    case 'followed_post': return parentId ? 'replies' : 'posts';
    case 'checkin_post':
    case 'community_group_post': return 'posts';
    case 'comment': return 'replies';
    case 'mention':
    case 'crew_wall_mention': return 'mentions';
    case 'status_update': return 'statuses';
    case 'follow': return 'follows';
    case 'boost': return 'boosts';
    default: return 'other';
  }
}

/** Existing query values remain compatible while the primary filters cover categories. */
export function notificationFilterWhere(kind?: NotificationKind | 'other'): Prisma.NotificationWhereInput {
  switch (kind) {
    case undefined: return {};
    case 'other': return { kind: { notIn: CATEGORIZED_KINDS } };
    case 'followed_post': return { OR: [
      { kind: { in: ['checkin_post', 'community_group_post'] } },
      { kind: 'followed_post', OR: [{ subjectPost: { is: { parentId: null } } }, { subjectPost: { is: null } }] },
    ] };
    case 'comment': return { OR: [
      { kind: 'comment' },
      { kind: 'followed_post', subjectPost: { is: { parentId: { not: null } } } },
    ] };
    case 'mention': return { kind: { in: ['mention', 'crew_wall_mention'] } };
    default: return { kind };
  }
}

export function notificationCategoryCounts(
  kinds: Partial<Record<NotificationKind | 'all', number>>,
  followedReplies: number,
): NotificationUnreadByCategory {
  const n = (kind: NotificationKind | 'all') => kinds[kind] ?? 0;
  const counts = {
    all: n('all'),
    posts: Math.max(0, n('followed_post') - followedReplies) + n('checkin_post') + n('community_group_post'),
    replies: n('comment') + followedReplies,
    mentions: n('mention') + n('crew_wall_mention'),
    statuses: n('status_update'), follows: n('follow'), boosts: n('boost'), other: 0,
  };
  counts.other = Math.max(0, counts.all - counts.posts - counts.replies - counts.mentions - counts.statuses - counts.follows - counts.boosts);
  return counts;
}
