import { NotificationKind } from '@prisma/client';
import { notificationCategory, notificationCategoryCounts, notificationFilterWhere } from './notification-category';

const dedicated = {
  posts: ['followed_post', 'checkin_post', 'community_group_post'],
  replies: ['comment'],
  mentions: ['mention', 'crew_wall_mention'],
  statuses: ['status_update'],
  follows: ['follow'],
  boosts: ['boost'],
};

describe('notification category contract', () => {
  it.each([...Object.values(NotificationKind), 'future_notification'])('%s is All and exactly one category', kind => {
    expect(notificationFilterWhere()).toEqual({});
    const expected = Object.entries(dedicated).find(([, kinds]) => kinds.includes(kind))?.[0] ?? 'other';
    expect(notificationCategory(kind)).toBe(expected);
    const other = notificationFilterWhere('other').kind as { notIn: string[] };
    expect(!other.notIn.includes(kind)).toBe(expected === 'other');
  });

  it('classifies by event even when the referenced post is a reply', () => {
    expect(notificationCategory('followed_post', 'parent')).toBe('replies');
    expect(notificationCategory('mention', 'parent')).toBe('mentions');
    expect(notificationCategory('boost', 'parent')).toBe('boosts');
    expect(notificationCategory('repost', 'parent')).toBe('other');
  });

  it('accounts for each unread record exactly once, including Other', () => {
    const counts = notificationCategoryCounts({ all: 26, followed_post: 7, checkin_post: 2, community_group_post: 3,
      comment: 2, mention: 2, crew_wall_mention: 1, status_update: 1, follow: 1, boost: 1, message: 2, repost: 4 }, 3);
    expect(counts).toEqual({ all: 26, posts: 9, replies: 5, mentions: 3, statuses: 1, follows: 1, boosts: 1, other: 6 });
    expect(Object.entries(counts).filter(([key]) => key !== 'all').reduce((sum, [, n]) => sum + n, 0)).toBe(counts.all);
  });
});
