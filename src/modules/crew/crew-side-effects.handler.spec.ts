/**
 * Unit tests for CrewSideEffectsHandler.
 *
 * The behaviour worth pinning down is that the handler decides who to notify from the CURRENT
 * database state rather than from the payload — that's what makes a retry (or a job that runs
 * seconds after the mutation) notify the right people.
 */
import { CrewSideEffectsHandler } from './crew-side-effects.handler';

function build(prismaOverrides: Record<string, any> = {}) {
  const prisma: any = {
    crewInvite: { findUnique: jest.fn(async () => null) },
    crewMember: { findMany: jest.fn(async () => []) },
    crewOwnerTransferVote: { findUnique: jest.fn(async () => ({ status: 'open' })) },
    crew: { findUnique: jest.fn(async () => null) },
    ...prismaOverrides,
  };
  const notifications = {
    create: jest.fn(async (_args: any) => undefined),
    markCrewInviteResolved: jest.fn(async () => undefined),
    upsertCrewMemberLeftNotification: jest.fn(async () => undefined),
    upsertCrewMemberKickedNotification: jest.fn(async () => undefined),
    upsertCrewDisbandedNotification: jest.fn(async () => undefined),
    deleteCrewJoinedNotificationsForActor: jest.fn(async () => undefined),
    sendCrewStreakAdvancedPush: jest.fn(async () => undefined),
  };
  const registry = { register: jest.fn() };
  const handler = new CrewSideEffectsHandler(prisma, notifications as any, registry as any);
  return { handler, prisma, notifications, registry };
}

const inviteRow = (overrides: Record<string, unknown> = {}) => ({
  id: 'invite-1',
  crewId: 'crew-1',
  invitedByUserId: 'inviter',
  inviteeUserId: 'invitee',
  message: 'come join',
  status: 'pending',
  ...overrides,
});

describe('crew.invite.sent', () => {
  it('notifies the invitee using the message stored on the row', async () => {
    const { handler, notifications } = build({
      crewInvite: { findUnique: jest.fn(async () => inviteRow()) },
    });

    await handler['onInviteSent']({ inviteId: 'invite-1' });

    expect(notifications.create).toHaveBeenCalledWith(
      expect.objectContaining({
        recipientUserId: 'invitee',
        kind: 'crew_invite_received',
        actorUserId: 'inviter',
        subjectCrewInviteId: 'invite-1',
        body: 'come join',
      }),
    );
  });

  /**
   * The invite can be cancelled between dispatch and delivery. Notifying then would put an
   * un-actionable invite in someone's bell.
   */
  it('does nothing when the invite is no longer pending', async () => {
    const { handler, notifications } = build({
      crewInvite: { findUnique: jest.fn(async () => inviteRow({ status: 'cancelled' })) },
    });

    await handler['onInviteSent']({ inviteId: 'invite-1' });

    expect(notifications.create).not.toHaveBeenCalled();
  });

  it('does nothing when the invite row is gone', async () => {
    const { handler, notifications } = build();

    await handler['onInviteSent']({ inviteId: 'invite-1' });

    expect(notifications.create).not.toHaveBeenCalled();
  });
});

describe('crew.invite.resolved', () => {
  it('tells the invitee when the inviter cancelled', async () => {
    const { handler, notifications } = build({
      crewInvite: { findUnique: jest.fn(async () => inviteRow({ status: 'cancelled' })) },
    });

    await handler['onInviteResolved']({ inviteId: 'invite-1' });

    expect(notifications.create).toHaveBeenCalledWith(
      expect.objectContaining({ recipientUserId: 'invitee', kind: 'crew_invite_cancelled', actorUserId: 'inviter' }),
    );
  });

  it('tells the inviter when the invitee declined', async () => {
    const { handler, notifications } = build({
      crewInvite: { findUnique: jest.fn(async () => inviteRow({ status: 'declined' })) },
    });

    await handler['onInviteResolved']({ inviteId: 'invite-1' });

    expect(notifications.create).toHaveBeenCalledWith(
      expect.objectContaining({ recipientUserId: 'inviter', kind: 'crew_invite_declined', actorUserId: 'invitee' }),
    );
  });

  /**
   * The inviter gets `crew_invite_accepted`; everyone else gets `crew_member_joined`. Sending
   * the inviter both for one event trains people to ignore the row.
   */
  it('notifies the inviter once and every other member about the join', async () => {
    const { handler, notifications } = build({
      crewInvite: { findUnique: jest.fn(async () => inviteRow({ status: 'accepted' })) },
      crewMember: {
        findMany: jest.fn(async () => [
          { userId: 'inviter' },
          { userId: 'invitee' },
          { userId: 'other-1' },
          { userId: 'other-2' },
        ]),
      },
    });

    await handler['onInviteResolved']({ inviteId: 'invite-1' });

    const calls = notifications.create.mock.calls.map(([args]: [any]) => [args.recipientUserId, args.kind]);
    expect(calls).toEqual([
      ['inviter', 'crew_invite_accepted'],
      ['other-1', 'crew_member_joined'],
      ['other-2', 'crew_member_joined'],
    ]);
  });

  it('clears the invitee stale invite row for every outcome, including expiry', async () => {
    const { handler, notifications } = build({
      crewInvite: { findUnique: jest.fn(async () => inviteRow({ status: 'expired' })) },
    });

    await handler['onInviteResolved']({ inviteId: 'invite-1' });

    expect(notifications.create).not.toHaveBeenCalled();
    expect(notifications.markCrewInviteResolved).toHaveBeenCalledWith('invitee', 'invite-1');
  });
});

describe('crew.member.removed', () => {
  it('notifies the remaining members when someone leaves', async () => {
    const { handler, notifications } = build({
      crewMember: { findMany: jest.fn(async () => [{ userId: 'stayer-1' }, { userId: 'stayer-2' }]) },
    });

    await handler['onMemberRemoved']({
      crewId: 'crew-1',
      actorUserId: 'leaver',
      subjectUserId: 'leaver',
      reason: 'left',
    });

    expect(notifications.upsertCrewMemberLeftNotification).toHaveBeenCalledTimes(2);
    expect(notifications.upsertCrewMemberKickedNotification).not.toHaveBeenCalled();
  });

  it('notifies only the removed member on a kick', async () => {
    const { handler, notifications } = build();

    await handler['onMemberRemoved']({
      crewId: 'crew-1',
      actorUserId: 'owner',
      subjectUserId: 'kicked-user',
      reason: 'kicked',
    });

    expect(notifications.upsertCrewMemberKickedNotification).toHaveBeenCalledWith({
      recipientUserId: 'kicked-user',
      actorUserId: 'owner',
      crewId: 'crew-1',
    });
    expect(notifications.upsertCrewMemberLeftNotification).not.toHaveBeenCalled();
  });

  it('tidies now-misleading "joined your crew" rows either way', async () => {
    const { handler, notifications } = build();

    await handler['onMemberRemoved']({
      crewId: 'crew-1',
      actorUserId: 'owner',
      subjectUserId: 'gone-user',
      reason: 'kicked',
    });

    expect(notifications.deleteCrewJoinedNotificationsForActor).toHaveBeenCalledWith({
      crewId: 'crew-1',
      actorUserId: 'gone-user',
    });
  });
});

describe('crew.owner.transferred', () => {
  it('notifies the current members and credits the previous owner as the actor', async () => {
    const { handler, notifications } = build({
      crewMember: { findMany: jest.fn(async () => [{ userId: 'm1' }, { userId: 'm2' }]) },
    });

    await handler['onOwnerTransferred']({
      crewId: 'crew-1',
      previousOwnerUserId: 'old-owner',
      newOwnerUserId: 'new-owner',
      reason: 'direct',
    });

    expect(notifications.create).toHaveBeenCalledTimes(2);
    expect(notifications.create).toHaveBeenCalledWith(
      expect.objectContaining({ recipientUserId: 'm1', kind: 'crew_owner_transferred', actorUserId: 'old-owner' }),
    );
  });

  /** Nobody performed an inactivity transfer, so attributing it to the old owner would lie. */
  it('has no actor for an inactivity transfer', async () => {
    const { handler, notifications } = build({
      crewMember: { findMany: jest.fn(async () => [{ userId: 'm1' }]) },
    });

    await handler['onOwnerTransferred']({
      crewId: 'crew-1',
      previousOwnerUserId: 'old-owner',
      newOwnerUserId: 'new-owner',
      reason: 'inactivity',
    });

    expect(notifications.create).toHaveBeenCalledWith(expect.objectContaining({ actorUserId: null }));
  });
});

describe('crew.transfer.vote.opened', () => {
  it('asks the non-owner members other than the proposer to vote', async () => {
    const { handler, notifications } = build({
      crewMember: { findMany: jest.fn(async () => [{ userId: 'proposer' }, { userId: 'voter-1' }]) },
    });

    await handler['onTransferVoteOpened']({ crewId: 'crew-1', voteId: 'vote-1', actorUserId: 'proposer' });

    expect(notifications.create).toHaveBeenCalledTimes(1);
    expect(notifications.create).toHaveBeenCalledWith(
      expect.objectContaining({ recipientUserId: 'voter-1', kind: 'crew_owner_transfer_vote' }),
    );
  });

  /** A 2-member crew resolves the vote instantly; asking anyone to vote then is noise. */
  it('stays quiet when the vote already closed', async () => {
    const { handler, notifications } = build({
      crewOwnerTransferVote: { findUnique: jest.fn(async () => ({ status: 'passed' })) },
      crewMember: { findMany: jest.fn(async () => [{ userId: 'voter-1' }]) },
    });

    await handler['onTransferVoteOpened']({ crewId: 'crew-1', voteId: 'vote-1', actorUserId: 'proposer' });

    expect(notifications.create).not.toHaveBeenCalled();
  });
});

describe('crew.wall.mentioned', () => {
  it('notifies each mentioned member but never the author', async () => {
    const { handler, notifications } = build();

    await handler['onWallMentioned']({
      crewId: 'crew-1',
      actorUserId: 'author',
      recipientUserIds: ['author', 'member-1', 'member-2'],
      bodySnippet: 'hey @member-1 @member-2',
    });

    const recipients = notifications.create.mock.calls.map(([args]: [any]) => args.recipientUserId);
    expect(recipients).toEqual(['member-1', 'member-2']);
  });
});

describe('crew.streak.advanced', () => {
  const crewRow = (overrides: Record<string, unknown> = {}) => ({
    id: 'crew-1',
    slug: 'the-crew',
    name: 'The Crew',
    currentStreakDays: 7,
    lastCompletedDayKey: '2026-08-03',
    members: [{ userId: 'm1' }, { userId: 'm2' }],
    ...overrides,
  });

  it('pushes the current streak count to every current member', async () => {
    const { handler, notifications } = build({
      crew: { findUnique: jest.fn(async () => crewRow()) },
    });

    await handler['onStreakAdvanced']({ crewId: 'crew-1', dayKey: '2026-08-03', currentStreakDays: 7 });

    expect(notifications.sendCrewStreakAdvancedPush).toHaveBeenCalledWith({
      recipientUserIds: ['m1', 'm2'],
      crewId: 'crew-1',
      crewSlug: 'the-crew',
      crewName: 'The Crew',
      currentStreakDays: 7,
      memberCount: 2,
    });
  });

  /** A retry after the day rolled over would otherwise push yesterday's milestone. */
  it('stays quiet when the crew has moved past the dispatched day', async () => {
    const { handler, notifications } = build({
      crew: { findUnique: jest.fn(async () => crewRow({ lastCompletedDayKey: '2026-08-04' })) },
    });

    await handler['onStreakAdvanced']({ crewId: 'crew-1', dayKey: '2026-08-03', currentStreakDays: 7 });

    expect(notifications.sendCrewStreakAdvancedPush).not.toHaveBeenCalled();
  });

  it('stays quiet when the crew was disbanded before the job ran', async () => {
    const { handler, notifications } = build({ crew: { findUnique: jest.fn(async () => null) } });

    await handler['onStreakAdvanced']({ crewId: 'crew-1', dayKey: '2026-08-03', currentStreakDays: 7 });

    expect(notifications.sendCrewStreakAdvancedPush).not.toHaveBeenCalled();
  });
});
