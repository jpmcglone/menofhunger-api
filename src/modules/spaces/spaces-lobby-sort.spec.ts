import { compareLobbySpaces } from './spaces-lobby-sort';

describe('compareLobbySpaces', () => {
  const viewerId = 'me';
  const followingOwnerIds = new Set(['friend']);

  function space(
    partial: Partial<Parameters<typeof compareLobbySpaces>[0]> & { id: string },
  ): Parameters<typeof compareLobbySpaces>[0] {
    return {
      isActive: false,
      scheduledAt: null,
      listenerCount: 0,
      viewerSubscribed: false,
      owner: { id: 'other' },
      ...partial,
    };
  }

  function sort(list: ReturnType<typeof space>[]) {
    return [...list].sort((a, b) =>
      compareLobbySpaces(a, b, { viewerId, followingOwnerIds }),
    );
  }

  it('orders own → notifying → following → soonest schedule', () => {
    const own = space({
      id: 'own',
      owner: { id: viewerId },
      scheduledAt: '2026-08-20T00:00:00.000Z',
    });
    const notifying = space({
      id: 'notify',
      viewerSubscribed: true,
      scheduledAt: '2026-08-21T00:00:00.000Z',
    });
    const followed = space({
      id: 'follow',
      owner: { id: 'friend' },
      viewerFollowsOwner: true,
      scheduledAt: '2026-08-22T00:00:00.000Z',
    });
    const soon = space({
      id: 'soon',
      scheduledAt: '2026-08-15T00:00:00.000Z',
    });
    const later = space({
      id: 'later',
      scheduledAt: '2026-08-30T00:00:00.000Z',
    });

    expect(sort([later, soon, followed, notifying, own]).map((s) => s.id)).toEqual([
      'own',
      'notify',
      'follow',
      'soon',
      'later',
    ]);
  });

  it('ranks a live room above an unfollowed scheduled space', () => {
    const live = space({ id: 'live', isActive: true, listenerCount: 2 });
    const scheduled = space({ id: 'soon', scheduledAt: '2026-08-15T00:00:00.000Z' });
    expect(sort([scheduled, live]).map((s) => s.id)).toEqual(['live', 'soon']);
  });

  it('ranks notifying above following even when follow has an earlier schedule', () => {
    const notifying = space({
      id: 'notify',
      viewerSubscribed: true,
      scheduledAt: '2026-08-28T00:00:00.000Z',
    });
    const followed = space({
      id: 'follow',
      owner: { id: 'friend' },
      scheduledAt: '2026-08-10T00:00:00.000Z',
    });
    expect(sort([followed, notifying]).map((s) => s.id)).toEqual(['notify', 'follow']);
  });
});
