import { permitsFollowNotification } from './follow-notification-policy';

describe('author notification preference delivery', () => {
  const input = { recipientUserId: 'viewer', actorUserId: 'author', kind: 'followed_post', subjectPostId: 'post' };
  function setup(preference: string | null, parentId: string | null = null) {
    const prisma = {
      follow: { findUnique: jest.fn(async () => preference ? { notificationPreference: preference } : null) },
      post: { findUnique: jest.fn(async () => ({ parentId, deletedAt: null })) },
    };
    return prisma;
  }
  it.each(['all', 'posts'])('allows top-level posts and articles for %s', async preference => {
    const prisma = setup(preference);
    expect(await permitsFollowNotification(prisma as never, input)).toBe(true);
    expect(await permitsFollowNotification(prisma as never, { ...input, kind: 'followed_article' })).toBe(true);
  });
  it.each(['off', null])('suppresses queued author alerts after preference changes to %s', async preference => {
    const prisma = setup(preference);
    for (const kind of ['followed_post', 'checkin_post', 'followed_article']) {
      expect(await permitsFollowNotification(prisma as never, { ...input, kind })).toBe(false);
    }
  });
  it('includes replies only for all activity', async () => {
    expect(await permitsFollowNotification(setup('posts', 'parent') as never, input)).toBe(false);
    expect(await permitsFollowNotification(setup('all', 'parent') as never, input)).toBe(true);
  });
  it.each(['comment', 'mention', 'message', 'community_group_post'])('leaves %s under its own settings', async kind => {
    const prisma = setup('off');
    expect(await permitsFollowNotification(prisma as never, { ...input, kind })).toBe(true);
    expect(prisma.follow.findUnique).not.toHaveBeenCalled();
  });
  it('does not deliver a deleted post', async () => {
    const prisma = setup('all');
    prisma.post.findUnique.mockResolvedValue(null as never);
    expect(await permitsFollowNotification(prisma as never, input)).toBe(false);
  });
});
