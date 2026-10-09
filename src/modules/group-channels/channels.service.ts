import { NOT_BANNED_USER_WHERE } from '../../common/prisma-selects/user.where';
import { USER_LIST_SELECT } from '../../common/prisma-selects/user.select';
import { AppConfigService } from '../app/app-config.service';
import { toUserListDto } from '../../common/dto/user.dto';
import type { GroupChannelMemberDto } from '../../common/dto/group-channel.dto';
import { SideEffectsService } from '../side-effects/side-effects.service';
import { BadRequestException, ForbiddenException, Injectable, NotFoundException } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import type { GroupChannelDto, GroupChannelViewerPayloadDto } from '../../common/dto/group-channel.dto';
import { PrismaService } from '../prisma/prisma.service';
import { PresenceRealtimeService } from '../presence/presence-realtime.service';
import { ChannelAccessService } from './channel-access.service';
import {
  DEFAULT_CHANNELS,
  assertChannelUpdate,
  defaultChannelIcon,
  channelCapabilities,
  isChannelLeader,
  normalizeChannelIcon,
  normalizeChannelName,
  normalizeChannelDisplayName,
} from './channel-policy';
import { slugifyChannelName } from '../../common/text/slugify';
import { lockChannelGroup } from './channel-lifecycle';
import { provisionDefaultChannels } from './channel-provisioning';
import { personalChannelMessageWhere } from './channel-attention-policy';

@Injectable()
export class ChannelsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly access: ChannelAccessService,
    private readonly realtime: PresenceRealtimeService,
    private readonly effects: SideEffectsService,
    private readonly config: AppConfigService,
  ) {}

  private readonly provisioned = new Set<string>();

  /** Groups created before channels existed get their defaults the first time a member opens them. */
  private async ensureDefaults(groupId: string) {
    if (this.provisioned.has(groupId)) return;
    const existing = await this.prisma.groupChannel.count({
      where: { groupId, defaultPurpose: { in: [...DEFAULT_CHANNELS] } },
    });
    if (existing < DEFAULT_CHANNELS.length) {
      const group = await this.prisma.communityGroup.findUnique({
        where: { id: groupId },
        select: { createdByUserId: true },
      });
      if (!group) return;
      await this.prisma.$transaction(async (tx) => {
        await lockChannelGroup(tx, groupId);
        await provisionDefaultChannels(tx, groupId, group.createdByUserId);
      });
    }
    this.provisioned.add(groupId);
  }

  private toDto(
    row: Prisma.GroupChannelGetPayload<object>,
    role: Parameters<typeof channelCapabilities>[1],
    viewer: { preference: string; readThrough: number; updatedAt: Date; mutedUntil?: Date | null; hidden?: boolean } | undefined,
    personalCount: number,
    hasUnread: boolean,
  ): GroupChannelDto {
    return {
      id: row.id,
      groupId: row.groupId,
      name: row.name,
      displayName: row.displayName,
      topic: row.topic,
      icon: row.defaultPurpose ? defaultChannelIcon(row.defaultPurpose) : row.icon,
      privacy: row.privacy,
      defaultPurpose: row.defaultPurpose,
      archivedAt: row.archivedAt?.toISOString() ?? null,
      revision: row.revision,
      preference: (viewer?.preference ?? 'mentions') as GroupChannelDto['preference'],
      hasUnread,
      mutedUntil: viewer?.mutedUntil && viewer.mutedUntil > new Date() ? viewer.mutedUntil.toISOString() : null,
      hidden: viewer?.hidden ?? false,
      readThrough: viewer?.readThrough ?? 0,
      viewerUpdatedAt: viewer?.updatedAt.toISOString() ?? null,
      personalCount,
      capabilities: channelCapabilities(row, role),
    };
  }

  async list(userId: string, groupId: string, onlyChannelId?: string): Promise<GroupChannelDto[]> {
    const member = await this.access.member(userId, groupId);
    await this.ensureDefaults(groupId);
    const rows = await this.prisma.groupChannel.findMany({
      where: { ...this.access.readableWhere(userId, groupId), ...(onlyChannelId ? { id: onlyChannelId } : {}) },
      include: {
        viewers: { where: { userId } },
        _count: {
          select: { attention: { where: { userId, readAt: null, message: personalChannelMessageWhere(userId) } } },
        },
      },
      orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
    });
    const unread = rows.length
      ? await this.prisma.$queryRaw<Array<{ id: string }>>(Prisma.sql`
      SELECT c.id FROM "GroupChannel" c
      LEFT JOIN "GroupChannelViewerState" v ON v."channelId" = c.id AND v."userId" = ${userId}
      WHERE c.id IN (${Prisma.join(rows.map((row) => row.id))})
        AND COALESCE(v.preference, 'mentions') <> 'off'
        AND NOT (v."mutedUntil" IS NOT NULL AND v."mutedUntil" > NOW())
        AND EXISTS (
          SELECT 1 FROM "Message" m
          LEFT JOIN "GroupChannelThreadState" t ON t."rootMessageId" = m."threadRootId" AND t."userId" = ${userId}
          WHERE m."conversationId" = c."conversationId" AND NOT m."deletedForAll" AND m.kind = 'text'
            AND m."senderId" <> ${userId} AND m."channelSequence" > COALESCE(v."readThrough", 0)
            AND (m."threadRootId" IS NULL OR m."channelSequence" > COALESCE(t."readThrough", 0))
        )
    `)
      : [];
    const unreadIds = new Set(unread.map((row) => row.id));
    return rows.map((row) => this.toDto(row, member.role, row.viewers[0], row._count.attention, unreadIds.has(row.id)));
  }

  async details(userId: string, groupId: string, channelId: string) {
    const row = (await this.list(userId, groupId, channelId))[0];
    if (!row) throw new NotFoundException('Channel unavailable.');
    return row;
  }

  /** Per-viewer channel snapshots for a whole audience in three queries, instead of one list per member. */
  async viewerSnapshots(
    channelId: string,
    members: Array<{ userId: string; role: Parameters<typeof channelCapabilities>[1] }>,
  ): Promise<Map<string, GroupChannelDto>> {
    const channel = await this.prisma.groupChannel.findUnique({ where: { id: channelId } });
    const result = new Map<string, GroupChannelDto>();
    if (!channel || !members.length) return result;
    const ids = Prisma.join(members.map((member) => member.userId));
    const [viewers, personal, unread] = await Promise.all([
      this.prisma.groupChannelViewerState.findMany({
        where: { channelId, userId: { in: members.map((member) => member.userId) } },
      }),
      this.prisma.$queryRaw<Array<{ userId: string; count: number }>>(Prisma.sql`
        SELECT a."userId", COUNT(*)::int AS count FROM "GroupChannelAttention" a
        JOIN "Message" m ON m.id = a."messageId" AND NOT m."deletedForAll"
        WHERE a."channelId" = ${channelId} AND a."readAt" IS NULL AND a."userId" IN (${ids})
          AND NOT EXISTS (SELECT 1 FROM "UserBlock" b WHERE (b."blockerId" = m."senderId" AND b."blockedId" = a."userId") OR (b."blockerId" = a."userId" AND b."blockedId" = m."senderId"))
          AND NOT EXISTS (SELECT 1 FROM "UserMute" x WHERE x."muterId" = a."userId" AND x."mutedId" = m."senderId")
        GROUP BY a."userId"`),
      this.prisma.$queryRaw<Array<{ userId: string }>>(Prisma.sql`
        SELECT u.id AS "userId" FROM "User" u
        LEFT JOIN "GroupChannelViewerState" v ON v."channelId" = ${channelId} AND v."userId" = u.id
        WHERE u.id IN (${ids}) AND COALESCE(v.preference, 'mentions') <> 'off'
          AND NOT (v."mutedUntil" IS NOT NULL AND v."mutedUntil" > NOW())
          AND EXISTS (
            SELECT 1 FROM "Message" m
            LEFT JOIN "GroupChannelThreadState" t ON t."rootMessageId" = m."threadRootId" AND t."userId" = u.id
            WHERE m."conversationId" = ${channel.conversationId} AND NOT m."deletedForAll" AND m.kind = 'text'
              AND m."senderId" <> u.id AND m."channelSequence" > COALESCE(v."readThrough", 0)
              AND (m."threadRootId" IS NULL OR m."channelSequence" > COALESCE(t."readThrough", 0))
          )`),
    ]);
    const viewerById = new Map(viewers.map((viewer) => [viewer.userId, viewer]));
    const personalById = new Map(personal.map((row) => [row.userId, row.count]));
    const unreadIds = new Set(unread.map((row) => row.userId));
    for (const member of members)
      result.set(
        member.userId,
        this.toDto(channel, member.role, viewerById.get(member.userId), personalById.get(member.userId) ?? 0, unreadIds.has(member.userId)),
      );
    return result;
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
    const recipients = reason === 'channel'
      ? await this.prisma.communityGroupMember.findMany({ where: { groupId, status: 'active', user: { ...NOT_BANNED_USER_WHERE, isBot: false, verifiedStatus: { not: 'none' } } }, select: { userId: true } })
      : await this.access.recipients(groupId, channelId);
    // Invalidations intentionally contain no content. Clients refetch through current authorization;
    // a membership change racing delivery cannot disclose a message body or private metadata.
    for (const { userId } of recipients) this.realtime.emitGroupChannelChanged(userId, { groupId, channelId, reason });
  }

  async create(
    userId: string,
    groupId: string,
    input: {
      name?: string;
      displayName?: string | null;
      topic?: string;
      icon?: string | null;
      privacy: 'normal' | 'private';
    },
  ) {
    const displayName = normalizeChannelDisplayName(input.displayName);
    const name = normalizeChannelName(input.name ?? slugifyChannelName(displayName ?? ''));
    const channel = await this.prisma.$transaction(async (tx) => {
      await this.access.lockGroup(tx, groupId);
      const member = await this.access.member(userId, groupId, tx);
      if (!isChannelLeader(member.role)) throw new ForbiddenException('Only group leaders can create channels.');
      if (await tx.groupChannel.findUnique({ where: { groupId_name: { groupId, name } } }))
        throw new BadRequestException('That channel name is already in use.');
      return tx.groupChannel.create({
        data: {
          group: { connect: { id: groupId } },
          name,
          displayName,
          topic: input.topic ?? '',
          icon: normalizeChannelIcon(input.icon),
          privacy: input.privacy,
          conversation: { create: { type: 'channel', createdByUserId: userId } },
          ...(input.privacy === 'private' ? { access: { create: { userId } } } : {}),
        },
      });
    });
    await this.changed(groupId, channel.id);
    return (await this.list(userId, groupId)).find((c) => c.id === channel.id)!;
  }

  async update(
    userId: string,
    groupId: string,
    channelId: string,
    input: { name?: string; displayName?: string | null; topic?: string; icon?: string | null; archived?: boolean },
  ) {
    await this.prisma.$transaction(async (tx) => {
      await this.access.lockGroup(tx, groupId);
      const { channel, member } = await this.access.channel(userId, groupId, channelId, tx);
      if (!isChannelLeader(member.role)) throw new ForbiddenException('Only group leaders can manage channels.');
      const name = input.name === undefined ? undefined : normalizeChannelName(input.name);
      const displayName = normalizeChannelDisplayName(input.displayName);
      assertChannelUpdate(channel, {
        ...input,
        name,
        displayName: input.displayName === undefined ? undefined : displayName,
      });
      if (name && name !== channel.name && (await tx.groupChannel.findUnique({ where: { groupId_name: { groupId, name } } })))
        throw new BadRequestException('That channel name is already in use.');
      await tx.groupChannel.update({
        where: { id: channelId },
        data: {
          name,
          topic: input.topic,
          ...(input.displayName === undefined ? {} : { displayName }),
          ...(input.icon === undefined ? {} : { icon: normalizeChannelIcon(input.icon) }),
          ...(input.archived === undefined ? {} : { archivedAt: input.archived ? new Date() : null }),
          revision: { increment: 1 },
        },
      });
    });
    await this.changed(groupId, channelId);
    return (await this.list(userId, groupId)).find((c) => c.id === channelId)!;
  }

  async members(userId: string, groupId: string, channelId: string, query = ''): Promise<GroupChannelMemberDto[]> {
    const { channel } = await this.access.channel(userId, groupId, channelId);
    const members = await this.prisma.communityGroupMember.findMany({
      where: {
        groupId,
        status: 'active',
        user: {
          ...NOT_BANNED_USER_WHERE,
          isBot: false,
          verifiedStatus: { not: 'none' },
          ...(channel.privacy === 'private' ? { channelAccess: { some: { channelId } } } : {}),
          ...(query
            ? {
                OR: [{ username: { contains: query, mode: 'insensitive' } }, { name: { contains: query, mode: 'insensitive' } }],
              }
            : {}),
        },
      },
      select: { role: true, user: { select: { ...USER_LIST_SELECT, isBot: true } } },
      take: 100,
      orderBy: [{ createdAt: 'asc' }, { userId: 'asc' }],
    });
    await this.access.channel(userId, groupId, channelId);
    return members.map(member => ({ role: member.role, user: toUserListDto(member.user, this.config.r2()?.publicBaseUrl ?? null) }));
  }

  async addMember(userId: string, groupId: string, channelId: string, targetId: string, historyAcknowledged: boolean) {
    if (!historyAcknowledged) throw new BadRequestException('Confirm that this member can read the channel history.');
    const added = await this.prisma.$transaction(async (tx) => {
      await this.access.lockGroup(tx, groupId);
      const { channel, member } = await this.access.channel(userId, groupId, channelId, tx);
      if (!isChannelLeader(member.role) || channel.privacy !== 'private' || channel.archivedAt)
        throw new ForbiddenException('You cannot add people to this channel.');
      await this.access.member(targetId, groupId, tx);
      const existing = await tx.groupChannelAccess.findUnique({
        where: { channelId_userId: { channelId, userId: targetId } },
      });
      if (existing) return false;
      await tx.groupChannelAccess.upsert({
        where: { channelId_userId: { channelId, userId: targetId } },
        create: { channelId, userId: targetId },
        update: {},
      });
      // Access does not back-notify historical mentions or replies.
      return true;
    });
    await this.changed(groupId, channelId, 'access');
    if (added) this.effects.dispatch('channel.member.added', { groupId, channelId, userId: targetId, actorUserId: userId });
  }

  async removeMember(userId: string, groupId: string, channelId: string, targetId: string) {
    await this.prisma.$transaction(async (tx) => {
      await this.access.lockGroup(tx, groupId);
      const { channel, member } = await this.access.channel(userId, groupId, channelId, tx);
      if (channel.privacy !== 'private' || (userId !== targetId && !isChannelLeader(member.role)))
        throw new ForbiddenException('You cannot remove this member.');
      const target = await tx.communityGroupMember.findUnique({
        where: { groupId_userId: { groupId, userId: targetId } },
      });
      if (target && isChannelLeader(target.role)) {
        const another = await tx.communityGroupMember.count({
          where: {
            groupId,
            status: 'active',
            userId: { not: targetId },
            role: { in: ['owner', 'moderator'] },
            user: {
              ...NOT_BANNED_USER_WHERE,
              isBot: false,
              verifiedStatus: { not: 'none' },
              channelAccess: { some: { channelId } },
            },
          },
        });
        if (!another) throw new BadRequestException('Add another group leader before leaving or removing the last leader.');
      }
      await tx.groupChannelAccess.deleteMany({ where: { channelId, userId: targetId } });
      await tx.groupChannelAttention.deleteMany({ where: { channelId, userId: targetId } });
      await tx.groupChannelViewerState.deleteMany({ where: { channelId, userId: targetId } });
      await tx.groupChannelThreadState.deleteMany({
        where: { userId: targetId, root: { conversationId: channel.conversationId } },
      });
    });
    this.effects.dispatch('notification.badge.sync', { recipientUserId: targetId });
    this.effects.dispatch('account.cluster.badge', { userId: targetId });
    this.realtime.emitGroupChannelChanged(targetId, { groupId, channelId, reason: 'access' });
    await this.changed(groupId, channelId, 'access');
  }
}
