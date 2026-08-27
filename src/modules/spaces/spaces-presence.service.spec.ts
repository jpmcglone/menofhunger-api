import { SpacesPresenceService } from './spaces-presence.service';

describe('SpacesPresenceService', () => {
  function build() {
    return new SpacesPresenceService(null);
  }

  it('join then leave by socket clears occupancy', () => {
    const svc = build();
    svc.join({ socketId: 's1', userId: 'u1', spaceId: 'space-1' });
    expect(svc.getLobbyCountsBySpaceId()).toEqual({ 'space-1': 1 });
    svc.leave('s1');
    expect(svc.getLobbyCountsBySpaceId()).toEqual({});
    expect(svc.getSpaceForUser('u1')).toBeNull();
  });

  it('leaveByUserId removes occupancy even when a leftover socket is not current', () => {
    const svc = build();
    svc.join({ socketId: 's1', userId: 'u1', spaceId: 'space-1' });
    svc.join({ socketId: 's2', userId: 'u1', spaceId: 'space-1' });
    // s1 disconnecting is not the current socket, so leave() keeps them here.
    expect(svc.leave('s1')).toEqual({ userId: 'u1', spaceId: 'space-1', wasActive: false });
    expect(svc.getLobbyCountsBySpaceId()).toEqual({ 'space-1': 1 });

    expect(svc.leaveByUserId('u1')).toEqual({ userId: 'u1', spaceId: 'space-1' });
    expect(svc.getLobbyCountsBySpaceId()).toEqual({});
    expect(svc.getSpaceForUser('u1')).toBeNull();
    expect(svc.leave('s2')).toBeNull();
  });

  it('pruneOfflineMembers keeps people who still have a live tab', () => {
    const svc = build();
    svc.join({ socketId: 's1', userId: 'online', spaceId: 'space-1' });
    svc.join({ socketId: 's2', userId: 'ghost', spaceId: 'space-1' });

    const dropped = svc.pruneOfflineMembers((userId) => userId === 'online');
    expect(dropped).toEqual([{ userId: 'ghost', spaceId: 'space-1' }]);
    expect(svc.getLobbyCountsBySpaceId()).toEqual({ 'space-1': 1 });
    expect(svc.getMembersForSpace('space-1').userIds).toEqual(['online']);
  });
});
