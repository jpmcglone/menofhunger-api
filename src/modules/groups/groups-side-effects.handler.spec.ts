/**
 * Unit tests for GroupsSideEffectsHandler — the notification fan-out for group invites,
 * join requests, and membership changes.
 */
import { GroupsSideEffectsHandler } from './groups-side-effects.handler';

function build(members: Array<{ userId: string }> = []) {
  const prisma: any = {
    communityGroupMember: { findMany: jest.fn(async () => members) },
  };
  const notifications = {
    create: jest.fn(async (_args: any) => undefined),
    upsertCommunityGroupInviteReceivedNotification: jest.fn(async () => ({ notified: true })),
    upsertCommunityGroupInviteResponseNotification: jest.fn(async () => undefined),
    upsertGroupJoinDecisionNotification: jest.fn(async () => undefined),
    upsertGroupMemberJoinedNotification: jest.fn(async () => undefined),
    upsertGroupMemberRemovedNotification: jest.fn(async () => undefined),
  };
  const registry = { register: jest.fn() };
  const handler = new GroupsSideEffectsHandler(prisma, notifications as any, registry as any);
  return { handler, prisma, notifications, registry };
}

describe('group invite effects', () => {
  it('upserts the received notification so a re-invite reuses one row', async () => {
    const { handler, notifications } = build();

    await handler['onInviteIssued']({
      groupId: 'g1',
      inviteId: 'i1',
      inviterUserId: 'inviter',
      inviteeUserId: 'invitee',
      bodySnippet: 'join us',
    });

    expect(notifications.upsertCommunityGroupInviteReceivedNotification).toHaveBeenCalledWith({
      inviteeUserId: 'invitee',
      inviterUserId: 'inviter',
      groupId: 'g1',
      inviteId: 'i1',
      bodySnippet: 'join us',
    });
  });

  it('notifies the invitee that the invite was pulled', async () => {
    const { handler, notifications } = build();

    await handler['onInviteCancelled']({
      groupId: 'g1',
      inviteId: 'i1',
      actorUserId: 'mod',
      inviteeUserId: 'invitee',
    });

    expect(notifications.create).toHaveBeenCalledWith(
      expect.objectContaining({
        recipientUserId: 'invitee',
        kind: 'community_group_invite_cancelled',
        actorUserId: 'mod',
      }),
    );
  });

  it('reports the response back to the inviter', async () => {
    const { handler, notifications } = build();

    await handler['onInviteResponded']({
      groupId: 'g1',
      inviteId: 'i1',
      inviterUserId: 'inviter',
      inviteeUserId: 'invitee',
      response: 'accepted',
    });

    expect(notifications.upsertCommunityGroupInviteResponseNotification).toHaveBeenCalledWith(
      expect.objectContaining({ inviterUserId: 'inviter', response: 'accepted' }),
    );
  });
});

describe('group.join.requested', () => {
  it('notifies owners and moderators, skipping the requester', async () => {
    const { handler, prisma, notifications } = build([{ userId: 'owner' }, { userId: 'requester' }]);

    await handler['onJoinRequested']({ groupId: 'g1', requestingUserId: 'requester' });

    expect(prisma.communityGroupMember.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { groupId: 'g1', status: 'active', role: { in: ['owner', 'moderator'] } },
      }),
    );
    const recipients = notifications.create.mock.calls.map(([args]: [any]) => args.recipientUserId);
    expect(recipients).toEqual(['owner']);
  });
});

describe('group.join.decided', () => {
  it('tells the approved user and then the existing members', async () => {
    const { handler, notifications } = build([{ userId: 'member-1' }, { userId: 'member-2' }]);

    await handler['onJoinDecided']({
      groupId: 'g1',
      userId: 'joiner',
      actorUserId: 'mod',
      decision: 'approved',
    });

    expect(notifications.upsertGroupJoinDecisionNotification).toHaveBeenCalledWith(
      expect.objectContaining({ recipientUserId: 'joiner', decision: 'approved' }),
    );
    expect(notifications.upsertGroupMemberJoinedNotification).toHaveBeenCalledTimes(2);
  });

  /** Nobody joined, so there is nothing to announce to the members. */
  it('only tells the rejected user', async () => {
    const { handler, notifications } = build([{ userId: 'member-1' }]);

    await handler['onJoinDecided']({
      groupId: 'g1',
      userId: 'joiner',
      actorUserId: 'mod',
      decision: 'rejected',
    });

    expect(notifications.upsertGroupJoinDecisionNotification).toHaveBeenCalledWith(
      expect.objectContaining({ decision: 'rejected' }),
    );
    expect(notifications.upsertGroupMemberJoinedNotification).not.toHaveBeenCalled();
  });
});

describe('group.member.joined', () => {
  it('excludes the joiner from the fan-out query', async () => {
    const { handler, prisma } = build([{ userId: 'member-1' }]);

    await handler['onMemberJoined']({ groupId: 'g1', joinerUserId: 'joiner' });

    expect(prisma.communityGroupMember.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { groupId: 'g1', status: 'active', userId: { not: 'joiner' } },
      }),
    );
  });
});

describe('group.member.removed', () => {
  it('notifies the removed member', async () => {
    const { handler, notifications } = build();

    await handler['onMemberRemoved']({ groupId: 'g1', userId: 'removed', actorUserId: 'mod' });

    expect(notifications.upsertGroupMemberRemovedNotification).toHaveBeenCalledWith({
      recipientUserId: 'removed',
      groupId: 'g1',
      actorUserId: 'mod',
    });
  });
});
