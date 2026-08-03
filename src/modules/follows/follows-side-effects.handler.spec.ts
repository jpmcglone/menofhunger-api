/**
 * The 24h de-dupe window lives in the handler, not the caller — so a retried job can't create
 * a second "followed you" row, and unfollow/refollow can't be used to spam a bell.
 */
import { FollowsSideEffectsHandler } from './follows-side-effects.handler';

function build(alreadyNotified = false) {
  const notifications = {
    hasRecentFollowNotification: jest.fn(async () => alreadyNotified),
    create: jest.fn(async () => undefined),
    deleteFollowNotification: jest.fn(async () => undefined),
  };
  const registry = { register: jest.fn() };
  const handler = new FollowsSideEffectsHandler(notifications as any, registry as any);
  return { handler, notifications, registry };
}

describe('follow.created', () => {
  it('notifies the followed user', async () => {
    const { handler, notifications } = build();

    await handler['onFollowCreated']({ actorUserId: 'follower', targetUserId: 'followed' });

    expect(notifications.create).toHaveBeenCalledWith(
      expect.objectContaining({
        recipientUserId: 'followed',
        kind: 'follow',
        actorUserId: 'follower',
        subjectUserId: 'follower',
      }),
    );
  });

  it('stays quiet inside the 24h window', async () => {
    const { handler, notifications } = build(true);

    await handler['onFollowCreated']({ actorUserId: 'follower', targetUserId: 'followed' });

    expect(notifications.create).not.toHaveBeenCalled();
  });

  it('checks the window against the target and actor, over 24 hours', async () => {
    const { handler, notifications } = build();

    await handler['onFollowCreated']({ actorUserId: 'follower', targetUserId: 'followed' });

    expect(notifications.hasRecentFollowNotification).toHaveBeenCalledWith(
      'followed',
      'follower',
      24 * 60 * 60 * 1000,
    );
  });
});

describe('follow.removed', () => {
  it('removes the follow notification', async () => {
    const { handler, notifications } = build();

    await handler['onFollowRemoved']({ actorUserId: 'follower', targetUserId: 'followed' });

    expect(notifications.deleteFollowNotification).toHaveBeenCalledWith('followed', 'follower');
  });
});
