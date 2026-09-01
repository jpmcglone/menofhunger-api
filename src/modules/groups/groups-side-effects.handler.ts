import { Injectable, type OnModuleInit } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { NotificationsService } from '../notifications/notifications.service';
import { FANOUT_CONCURRENCY, runInBatches } from '../side-effects/batch';
import type { SideEffectPayloads } from '../side-effects/side-effects.constants';
import { SideEffectsRegistry } from '../side-effects/side-effects.registry';

/**
 * Post-commit notification work for community groups: invites, join requests and decisions,
 * membership changes.
 *
 * Group membership can be large, so every fan-out here goes through `runInBatches` rather
 * than one promise per member.
 */
@Injectable()
export class GroupsSideEffectsHandler implements OnModuleInit {
  constructor(
    private readonly prisma: PrismaService,
    private readonly notifications: NotificationsService,
    private readonly registry: SideEffectsRegistry,
  ) {}

  onModuleInit(): void {
    this.registry.register('group.invite.issued', (p) => this.onInviteIssued(p));
    this.registry.register('group.invite.cancelled', (p) => this.onInviteCancelled(p));
    this.registry.register('group.invite.responded', (p) => this.onInviteResponded(p));
    this.registry.register('group.join.requested', (p) => this.onJoinRequested(p));
    this.registry.register('group.join.decided', (p) => this.onJoinDecided(p));
    this.registry.register('group.member.joined', (p) => this.onMemberJoined(p));
    this.registry.register('group.member.removed', (p) => this.onMemberRemoved(p));
  }

  private async onInviteIssued(payload: SideEffectPayloads['group.invite.issued']): Promise<void> {
    await this.notifications.upsertCommunityGroupInviteReceivedNotification({
      inviteeUserId: payload.inviteeUserId,
      inviterUserId: payload.inviterUserId,
      groupId: payload.groupId,
      inviteId: payload.inviteId,
      bodySnippet: payload.bodySnippet,
    });
  }

  private async onInviteCancelled(payload: SideEffectPayloads['group.invite.cancelled']): Promise<void> {
    await this.notifications.create({
      recipientUserId: payload.inviteeUserId,
      kind: 'community_group_invite_cancelled',
      actorUserId: payload.actorUserId,
      subjectGroupId: payload.groupId,
      subjectCommunityGroupInviteId: payload.inviteId,
    });
  }

  private async onInviteResponded(payload: SideEffectPayloads['group.invite.responded']): Promise<void> {
    // Decline is a quiet no — the inviter's pending list updates over the socket.
    if (payload.response === 'declined') return;
    await this.notifications.upsertCommunityGroupInviteResponseNotification({
      inviterUserId: payload.inviterUserId,
      inviteeUserId: payload.inviteeUserId,
      groupId: payload.groupId,
      inviteId: payload.inviteId,
      response: payload.response,
    });
  }

  private async onJoinRequested(payload: SideEffectPayloads['group.join.requested']): Promise<void> {
    const admins = await this.prisma.communityGroupMember.findMany({
      where: { groupId: payload.groupId, status: 'active', role: { in: ['owner', 'moderator'] } },
      select: { userId: true },
    });
    const recipients = admins.map((a) => a.userId).filter((id) => id !== payload.requestingUserId);

    await runInBatches(recipients, FANOUT_CONCURRENCY, async (recipientUserId) => {
      await this.notifications.create({
        recipientUserId,
        kind: 'group_join_request',
        actorUserId: payload.requestingUserId,
        subjectGroupId: payload.groupId,
      });
    });
  }

  private async onJoinDecided(payload: SideEffectPayloads['group.join.decided']): Promise<void> {
    await this.notifications.upsertGroupJoinDecisionNotification({
      recipientUserId: payload.userId,
      groupId: payload.groupId,
      actorUserId: payload.actorUserId,
      decision: payload.decision,
    });

    if (payload.decision === 'approved') {
      await this.fanOutMemberJoined({ groupId: payload.groupId, joinerUserId: payload.userId });
    }
  }

  private async onMemberJoined(payload: SideEffectPayloads['group.member.joined']): Promise<void> {
    await this.fanOutMemberJoined(payload);
  }

  private async fanOutMemberJoined(params: { groupId: string; joinerUserId: string }): Promise<void> {
    const members = await this.prisma.communityGroupMember.findMany({
      where: { groupId: params.groupId, status: 'active', userId: { not: params.joinerUserId } },
      select: { userId: true },
    });

    await runInBatches(members, FANOUT_CONCURRENCY, async (member) => {
      await this.notifications.upsertGroupMemberJoinedNotification({
        recipientUserId: member.userId,
        joinerUserId: params.joinerUserId,
        groupId: params.groupId,
      });
    });
  }

  private async onMemberRemoved(payload: SideEffectPayloads['group.member.removed']): Promise<void> {
    await this.notifications.upsertGroupMemberRemovedNotification({
      recipientUserId: payload.userId,
      groupId: payload.groupId,
      actorUserId: payload.actorUserId,
    });
  }
}
