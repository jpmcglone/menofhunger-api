import { Injectable, Logger, type OnModuleInit } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { NotificationsService } from '../notifications/notifications.service';
import { FANOUT_CONCURRENCY, runInBatches } from '../side-effects/batch';
import type { SideEffectPayloads } from '../side-effects/side-effects.constants';
import { SideEffectsRegistry } from '../side-effects/side-effects.registry';

/**
 * Post-commit notification work for crew mutations.
 *
 * Crews are capped at a handful of members, so the fan-out here is small — what the queue
 * buys is that an invite accept no longer does seven sequential notification writes (each a
 * transaction plus a push) inside the user's HTTP request.
 *
 * Every handler re-reads the crew/invite row rather than trusting a payload snapshot, so a
 * retry minutes later notifies the right people about the state that actually exists.
 */
@Injectable()
export class CrewSideEffectsHandler implements OnModuleInit {
  private readonly logger = new Logger(CrewSideEffectsHandler.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly notifications: NotificationsService,
    private readonly registry: SideEffectsRegistry,
  ) {}

  onModuleInit(): void {
    this.registry.register('crew.invite.sent', (p) => this.onInviteSent(p));
    this.registry.register('crew.invite.resolved', (p) => this.onInviteResolved(p));
    this.registry.register('crew.member.removed', (p) => this.onMemberRemoved(p));
    this.registry.register('crew.disbanded', (p) => this.onDisbanded(p));
    this.registry.register('crew.owner.transferred', (p) => this.onOwnerTransferred(p));
    this.registry.register('crew.transfer.vote.opened', (p) => this.onTransferVoteOpened(p));
    this.registry.register('crew.wall.mentioned', (p) => this.onWallMentioned(p));
    this.registry.register('crew.streak.advanced', (p) => this.onStreakAdvanced(p));
  }

  /**
   * Push the shared-streak milestone to every current member.
   *
   * The member list and streak count are re-read so a retry can't push a stale number, and
   * `lastCompletedDayKey` is checked so a retry after the day rolled over sends nothing.
   */
  private async onStreakAdvanced(payload: SideEffectPayloads['crew.streak.advanced']): Promise<void> {
    const crew = await this.prisma.crew.findUnique({
      where: { id: payload.crewId },
      select: {
        id: true,
        slug: true,
        name: true,
        currentStreakDays: true,
        lastCompletedDayKey: true,
        members: { select: { userId: true } },
      },
    });
    if (!crew || crew.lastCompletedDayKey !== payload.dayKey) return;

    const recipientUserIds = crew.members.map((m) => m.userId).filter(Boolean);
    if (recipientUserIds.length === 0) return;

    await this.notifications.sendCrewStreakAdvancedPush({
      recipientUserIds,
      crewId: crew.id,
      crewSlug: crew.slug,
      crewName: crew.name,
      currentStreakDays: crew.currentStreakDays ?? payload.currentStreakDays,
      memberCount: recipientUserIds.length,
    });
  }

  private async onInviteSent(payload: SideEffectPayloads['crew.invite.sent']): Promise<void> {
    const invite = await this.prisma.crewInvite.findUnique({
      where: { id: payload.inviteId },
      select: { id: true, crewId: true, invitedByUserId: true, inviteeUserId: true, message: true, status: true },
    });
    if (!invite || invite.status !== 'pending') return;

    await this.notifications.create({
      recipientUserId: invite.inviteeUserId,
      kind: 'crew_invite_received',
      actorUserId: invite.invitedByUserId,
      subjectCrewId: invite.crewId,
      subjectCrewInviteId: invite.id,
      body: (invite.message ?? '').trim().slice(0, 200) || null,
    });
  }

  /**
   * Accept / decline / cancel share this handler because they share a shape: tell the other
   * party what happened, then clear the invitee's "you've been invited" row so their bell
   * badge stops counting an invite they can no longer act on.
   */
  private async onInviteResolved(payload: SideEffectPayloads['crew.invite.resolved']): Promise<void> {
    const invite = await this.prisma.crewInvite.findUnique({
      where: { id: payload.inviteId },
      select: { id: true, crewId: true, invitedByUserId: true, inviteeUserId: true, status: true },
    });
    if (!invite) return;

    const { invitedByUserId: inviterUserId, inviteeUserId, crewId } = invite;

    if (invite.status === 'cancelled') {
      await this.notifications.create({
        recipientUserId: inviteeUserId,
        kind: 'crew_invite_cancelled',
        actorUserId: inviterUserId,
        subjectCrewId: crewId,
        subjectCrewInviteId: invite.id,
      });
    } else if (invite.status === 'declined') {
      await this.notifications.create({
        recipientUserId: inviterUserId,
        kind: 'crew_invite_declined',
        actorUserId: inviteeUserId,
        subjectCrewId: crewId,
        subjectCrewInviteId: invite.id,
      });
    } else if (invite.status === 'accepted') {
      await this.notifications.create({
        recipientUserId: inviterUserId,
        kind: 'crew_invite_accepted',
        actorUserId: inviteeUserId,
        subjectCrewId: crewId,
        subjectCrewInviteId: invite.id,
      });
      await this.notifyMembersOfJoin({ crewId, joinerUserId: inviteeUserId, inviterUserId });
    }

    await this.notifications.markCrewInviteResolved(inviteeUserId, invite.id);
  }

  /**
   * Tell existing members someone joined. The inviter is skipped — they already got
   * `crew_invite_accepted`, and two rows for one event trains people to ignore both.
   */
  private async notifyMembersOfJoin(params: {
    crewId: string | null;
    joinerUserId: string;
    inviterUserId: string;
  }): Promise<void> {
    if (!params.crewId) return;
    const members = await this.prisma.crewMember.findMany({
      where: { crewId: params.crewId },
      select: { userId: true },
    });
    const recipients = members
      .map((m) => m.userId)
      .filter((id) => id !== params.joinerUserId && id !== params.inviterUserId);

    await runInBatches(recipients, FANOUT_CONCURRENCY, async (recipientUserId) => {
      await this.notifications.create({
        recipientUserId,
        kind: 'crew_member_joined',
        actorUserId: params.joinerUserId,
        subjectCrewId: params.crewId,
      });
    });
  }

  private async onMemberRemoved(payload: SideEffectPayloads['crew.member.removed']): Promise<void> {
    // Tidy stale "X joined your crew" / "X accepted your crew invite" rows on the other
    // members — X is not a member any more, so those rows point nowhere useful.
    await this.notifications.deleteCrewJoinedNotificationsForActor({
      crewId: payload.crewId,
      actorUserId: payload.subjectUserId,
    });

    if (payload.reason === 'kicked') {
      await this.notifications.upsertCrewMemberKickedNotification({
        recipientUserId: payload.subjectUserId,
        actorUserId: payload.actorUserId,
        crewId: payload.crewId,
      });
      return;
    }

    const remaining = await this.prisma.crewMember.findMany({
      where: { crewId: payload.crewId },
      select: { userId: true },
    });
    await runInBatches(remaining, FANOUT_CONCURRENCY, async (member) => {
      await this.notifications.upsertCrewMemberLeftNotification({
        recipientUserId: member.userId,
        leaverUserId: payload.subjectUserId,
        crewId: payload.crewId,
      });
    });
  }

  private async onDisbanded(payload: SideEffectPayloads['crew.disbanded']): Promise<void> {
    const actorUserId = payload.actorUserId;
    if (!actorUserId) return;

    await runInBatches(payload.memberUserIds, FANOUT_CONCURRENCY, async (recipientUserId) => {
      await this.notifications.upsertCrewDisbandedNotification({
        recipientUserId,
        actorUserId,
        crewId: payload.crewId,
      });
    });
  }

  private async onOwnerTransferred(payload: SideEffectPayloads['crew.owner.transferred']): Promise<void> {
    const members = await this.prisma.crewMember.findMany({
      where: { crewId: payload.crewId },
      select: { userId: true },
    });

    await runInBatches(members, FANOUT_CONCURRENCY, async (member) => {
      await this.notifications.create({
        recipientUserId: member.userId,
        kind: 'crew_owner_transferred',
        // An inactivity-driven transfer has no human actor.
        actorUserId: payload.reason === 'inactivity' ? null : payload.previousOwnerUserId,
        subjectCrewId: payload.crewId,
      });
    });
  }

  private async onTransferVoteOpened(
    payload: SideEffectPayloads['crew.transfer.vote.opened'],
  ): Promise<void> {
    const vote = await this.prisma.crewOwnerTransferVote.findUnique({
      where: { id: payload.voteId },
      select: { status: true },
    });
    // A 2-member crew resolves the vote immediately, so by the time this job runs there may be
    // nothing left to vote on — asking people to vote then would be noise.
    if (!vote || vote.status !== 'open') return;

    const nonOwners = await this.prisma.crewMember.findMany({
      where: { crewId: payload.crewId, role: 'member' },
      select: { userId: true },
    });
    const recipients = nonOwners.map((m) => m.userId).filter((id) => id !== payload.actorUserId);

    await runInBatches(recipients, FANOUT_CONCURRENCY, async (recipientUserId) => {
      await this.notifications.create({
        recipientUserId,
        kind: 'crew_owner_transfer_vote',
        actorUserId: payload.actorUserId,
        subjectCrewId: payload.crewId,
      });
    });
  }

  private async onWallMentioned(payload: SideEffectPayloads['crew.wall.mentioned']): Promise<void> {
    const recipients = payload.recipientUserIds.filter((id) => id && id !== payload.actorUserId);
    if (recipients.length === 0) return;

    const result = await runInBatches(recipients, FANOUT_CONCURRENCY, async (recipientUserId) => {
      await this.notifications.create({
        recipientUserId,
        kind: 'crew_wall_mention',
        actorUserId: payload.actorUserId,
        subjectCrewId: payload.crewId,
        body: payload.bodySnippet,
      });
    });

    if (result.failed > 0) {
      this.logger.warn(`[crew] wall mention fan-out: ${result.failed}/${recipients.length} failed.`);
    }
  }
}
