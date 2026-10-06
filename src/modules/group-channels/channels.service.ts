import { SideEffectsService } from '../side-effects/side-effects.service';
import { BadRequestException, ForbiddenException, Injectable, NotFoundException } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import type { GroupChannelDto, GroupChannelViewerPayloadDto } from '../../common/dto/group-channel.dto';
import { PrismaService } from '../prisma/prisma.service';
import { PresenceRealtimeService } from '../presence/presence-realtime.service';
import { ChannelAccessService } from './channel-access.service';
import { DEFAULT_CHANNELS, assertChannelUpdate, channelCapabilities, isChannelLeader, normalizeChannelIcon, normalizeChannelName, normalizeChannelDisplayName, slugifyChannelName } from './channel-policy';
import { lockChannelGroup } from './channel-lifecycle';
import { provisionDefaultChannels } from './channel-provisioning';
import { personalChannelMessageWhere } from './channel-attention-policy';

@Injectable()
export class ChannelsService {
  constructor(private readonly prisma: PrismaService, private readonly access: ChannelAccessService, private readonly realtime: PresenceRealtimeService, private readonly effects: SideEffectsService) {}

  /** Groups created before channels existed get their defaults the first time a member opens them. */
  private async ensureDefaults(groupId: string) {
    const existing = await this.prisma.groupChannel.count({ where: { groupId, defaultPurpose: { in: [...DEFAULT_CHANNELS] } } });
    if (existing >= DEFAULT_CHANNELS.length) return;
    const group = await this.prisma.communityGroup.findUnique({ where: { id: groupId }, select: { createdByUserId: true } });
    if (!group) return;
    await this.prisma.$transaction(async tx => {
      await lockChannelGroup(tx, groupId);
      await provisionDefaultChannels(tx, groupId, group.createdByUserId);
    });
  }

  async list(userId: string, groupId: string): Promise<GroupChannelDto[]> {
    const member = await this.access.member(userId, groupId);
    await this.ensureDefaults(groupId);
    const rows = await this.prisma.groupChannel.findMany({
      where: this.access.readableWhere(userId, groupId),
      include: { viewers: { where: { userId } }, _count: { select: { attention: { where: { userId, readAt: null, message: personalChannelMessageWhere(userId) } } } } },
      orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
    });
    const unread = rows.length ? await this.prisma.$queryRaw<Array<{ id: string }>>(Prisma.sql`
      SELECT c.id FROM "GroupChannel" c
      LEFT JOIN "GroupChannelViewerState" v ON v."channelId" = c.id AND v."userId" = ${userId}
      WHERE c.id IN (${Prisma.join(rows.map(row => row.id))})
        AND COALESCE(v.preference, 'mentions') <> 'off'
        AND EXISTS (
          SELECT 1 FROM "Message" m
          LEFT JOIN "GroupChannelThreadState" t ON t."rootMessageId" = m."threadRootId" AND t."userId" = ${userId}
          WHERE m."conversationId" = c."conversationId" AND NOT m."deletedForAll"
            AND m."senderId" <> ${userId} AND m."channelSequence" > COALESCE(v."readThrough", 0)
            AND (m."threadRootId" IS NULL OR m."channelSequence" > COALESCE(t."readThrough", 0))
        )
    `) : [];
    const unreadIds = new Set(unread.map(row => row.id));
    return rows.map(row => ({
      id: row.id, groupId, name: row.name, displayName: row.displayName, topic: row.topic, icon: row.icon, privacy: row.privacy,
      defaultPurpose: row.defaultPurpose, archivedAt: row.archivedAt?.toISOString() ?? null, revision: row.revision,
      preference: row.viewers[0]?.preference ?? 'mentions',
      hasUnread: unreadIds.has(row.id),
      readThrough: row.viewers[0]?.readThrough ?? 0,
      viewerUpdatedAt: row.viewers[0]?.updatedAt.toISOString() ?? null,
      personalCount: row._count.attention, capabilities: channelCapabilities(row, member.role),
    }));
  }

  async details(userId: string, groupId: string, channelId: string) {
    const row = (await this.list(userId, groupId)).find(channel => channel.id === channelId);
    if (!row) throw new NotFoundException('Channel unavailable.');
    return row;
  }

  async viewerChanged(userId: string, groupId: string, channelId: string, patch: Omit<GroupChannelViewerPayloadDto, 'groupId' | 'channel'> = {}) {
    try {
      const channel = await this.details(userId, groupId, channelId);
      this.realtime.emitGroupChannelViewer(userId, { groupId, channel, ...patch });
    } catch (error) {
      if (!(error instanceof NotFoundException)) throw error;
    }
  }

  async changed(groupId: string, channelId: string, reason: 'channel' | 'messages' | 'attention' | 'access' = 'channel') {
    const recipients = await this.access.recipients(groupId, channelId);
    // Invalidations intentionally contain no content. Clients refetch through current authorization;
    // a membership change racing delivery cannot disclose a message body or private metadata.
    for (const { userId } of recipients) this.realtime.emitGroupChannelChanged(userId, { groupId, channelId, reason });
  }

  async create(userId: string, groupId: string, input: { name?: string; displayName?: string | null; topic?: string; icon?: string | null; privacy: 'normal' | 'private' }) {
    const displayName = normalizeChannelDisplayName(input.displayName);
    const name = normalizeChannelName(input.name ?? slugifyChannelName(displayName ?? ''));
    const channel = await this.prisma.$transaction(async tx => {
      await this.access.lockGroup(tx, groupId);
      const member = await this.access.member(userId, groupId, tx);
      if (!isChannelLeader(member.role)) throw new ForbiddenException('Only group leaders can create channels.');
      if (await tx.groupChannel.findUnique({ where: { groupId_name: { groupId, name } } })) throw new BadRequestException('That channel name is already in use.');
      return tx.groupChannel.create({ data: {
        group: { connect: { id: groupId } }, name, displayName, topic: input.topic ?? '', icon: normalizeChannelIcon(input.icon), privacy: input.privacy,
        conversation: { create: { type: 'channel', createdByUserId: userId } },
        ...(input.privacy === 'private' ? { access: { create: { userId } } } : {}),
      } });
    });
    await this.changed(groupId, channel.id);
    return (await this.list(userId, groupId)).find(c => c.id === channel.id)!;
  }

  async update(userId: string, groupId: string, channelId: string, input: { name?: string; displayName?: string | null; topic?: string; icon?: string | null; archived?: boolean }) {
    await this.prisma.$transaction(async tx => {
      await this.access.lockGroup(tx, groupId);
      const { channel, member } = await this.access.channel(userId, groupId, channelId, tx);
      if (!isChannelLeader(member.role)) throw new ForbiddenException('Only group leaders can manage channels.');
      const name = input.name === undefined ? undefined : normalizeChannelName(input.name);
      const displayName = normalizeChannelDisplayName(input.displayName);
      assertChannelUpdate(channel, { ...input, name, displayName: input.displayName === undefined ? undefined : displayName });
      if (name && name !== channel.name && await tx.groupChannel.findUnique({ where: { groupId_name: { groupId, name } } })) throw new BadRequestException('That channel name is already in use.');
      await tx.groupChannel.update({ where: { id: channelId }, data: {
        name, topic: input.topic,
        ...(input.displayName === undefined ? {} : { displayName }),
        ...(input.icon === undefined ? {} : { icon: normalizeChannelIcon(input.icon) }),
        ...(input.archived === undefined ? {} : { archivedAt: input.archived ? new Date() : null }),
        revision: { increment: 1 },
      } });
    });
    await this.changed(groupId, channelId);
    return (await this.list(userId, groupId)).find(c => c.id === channelId)!;
  }

  async members(userId: string, groupId: string, channelId: string, query = '') {
    const { channel } = await this.access.channel(userId, groupId, channelId);
    return this.prisma.communityGroupMember.findMany({
      where: { groupId, status: 'active', user: {
        bannedAt: null, isBot: false, verifiedStatus: { not: 'none' },
        ...(channel.privacy === 'private' ? { channelAccess: { some: { channelId } } } : {}),
        ...(query ? { OR: [{ username: { contains: query, mode: 'insensitive' } }, { name: { contains: query, mode: 'insensitive' } }] } : {}),
      } },
      select: { role: true, user: { select: { id: true, username: true, name: true, isBot: true } } }, take: 100,
      orderBy: [{ createdAt: 'asc' }, { userId: 'asc' }],
    });
  }

  async addMember(userId: string, groupId: string, channelId: string, targetId: string, historyAcknowledged: boolean) {
    if (!historyAcknowledged) throw new BadRequestException('Confirm that this member can read the channel history.');
    const added = await this.prisma.$transaction(async tx => {
      await this.access.lockGroup(tx, groupId);
      const { channel, member } = await this.access.channel(userId, groupId, channelId, tx);
      if (!isChannelLeader(member.role) || channel.privacy !== 'private' || channel.archivedAt) throw new ForbiddenException('You cannot add people to this channel.');
      await this.access.member(targetId, groupId, tx);
      const existing = await tx.groupChannelAccess.findUnique({ where: { channelId_userId: { channelId, userId: targetId } } });
      if (existing) return false;
      await tx.groupChannelAccess.upsert({ where: { channelId_userId: { channelId, userId: targetId } }, create: { channelId, userId: targetId }, update: {} });
      // Access does not back-notify historical mentions or replies.
      return true;
    });
    await this.changed(groupId, channelId, 'access');
    if (added) this.effects.dispatch('channel.member.added', { groupId, channelId, userId: targetId, actorUserId: userId });
  }

  async removeMember(userId: string, groupId: string, channelId: string, targetId: string) {
    await this.prisma.$transaction(async tx => {
      await this.access.lockGroup(tx, groupId);
      const { channel, member } = await this.access.channel(userId, groupId, channelId, tx);
      if (channel.privacy !== 'private' || (userId !== targetId && !isChannelLeader(member.role))) throw new ForbiddenException('You cannot remove this member.');
      const target = await tx.communityGroupMember.findUnique({ where: { groupId_userId: { groupId, userId: targetId } } });
      if (target && isChannelLeader(target.role)) {
        const another = await tx.communityGroupMember.count({ where: { groupId, status: 'active', userId: { not: targetId }, role: { in: ['owner', 'moderator'] }, user: { bannedAt: null, isBot: false, verifiedStatus: { not: 'none' }, channelAccess: { some: { channelId } } } } });
        if (!another) throw new BadRequestException('Add another group leader before leaving or removing the last leader.');
      }
      await tx.groupChannelAccess.deleteMany({ where: { channelId, userId: targetId } });
      await tx.groupChannelAttention.deleteMany({ where: { channelId, userId: targetId } });
      await tx.groupChannelViewerState.deleteMany({ where: { channelId, userId: targetId } });
      await tx.groupChannelThreadState.deleteMany({ where: { userId: targetId, root: { conversationId: channel.conversationId } } });
    });
    this.effects.dispatch('notification.badge.sync', { recipientUserId: targetId });
    this.effects.dispatch('account.cluster.badge', { userId: targetId });
    this.realtime.emitGroupChannelChanged(targetId, { groupId, channelId, reason: 'access' });
    await this.changed(groupId, channelId, 'access');
  }
}
