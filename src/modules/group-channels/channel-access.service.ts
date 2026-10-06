import { Injectable, NotFoundException } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { lockChannelGroup } from './channel-lifecycle';
import { AppConfigService } from '../app/app-config.service';
import { PrismaService } from '../prisma/prisma.service';
import { personalChannelMessageWhere } from './channel-attention-policy';

@Injectable()
export class ChannelAccessService {
  constructor(private readonly prisma: PrismaService, private readonly config: AppConfigService) {}

  enabled(groupId: string) {
    const rollout = this.config.groupChannels();
    return rollout.enabled && (!rollout.groupIds.length || rollout.groupIds.includes(groupId));
  }

  async member(userId: string, groupId: string, db: Prisma.TransactionClient = this.prisma) {
    if (!this.enabled(groupId)) throw new NotFoundException('Channel unavailable.');
    const member = await db.communityGroupMember.findUnique({
      where: { groupId_userId: { groupId, userId } },
      include: { group: { select: { deletedAt: true } }, user: { select: { bannedAt: true, verifiedStatus: true, premium: true, premiumPlus: true, isBot: true } } },
    });
    const user = member?.user;
    if (!member || member.status !== 'active' || member.group.deletedAt || !user || user.bannedAt || user.isBot ||
      user.verifiedStatus === 'none') throw new NotFoundException('Channel unavailable.');
    return member;
  }

  readableWhere(userId: string, groupId: string): Prisma.GroupChannelWhereInput {
    return { groupId, OR: [{ privacy: 'normal' }, { access: { some: { userId } } }] };
  }

  async channel(userId: string, groupId: string, channelId: string, db: Prisma.TransactionClient = this.prisma) {
    const member = await this.member(userId, groupId, db);
    const channel = await db.groupChannel.findFirst({ where: { id: channelId, ...this.readableWhere(userId, groupId) } });
    if (!channel) throw new NotFoundException('Channel unavailable.');
    return { channel, member };
  }

  /** All channel mutations serialize against membership/lifecycle changes. */
  async lockGroup(tx: Prisma.TransactionClient, groupId: string) {
    await lockChannelGroup(tx, groupId);
  }

  /** One access-filtered attention row is one badge, regardless of reason or surface. */
  async personalCount(userId: string, groupId?: string) {
    const rollout = this.config.groupChannels();
    if (!rollout.enabled || (groupId && !this.enabled(groupId))) return 0;
    return this.prisma.groupChannelAttention.count({ where: {
      userId, readAt: null, message: personalChannelMessageWhere(userId),
      channel: {
        ...(groupId ? { groupId } : rollout.groupIds.length ? { groupId: { in: rollout.groupIds } } : {}),
        OR: [{ privacy: 'normal' }, { access: { some: { userId } } }],
        group: { deletedAt: null, members: { some: { userId, status: 'active', user: { bannedAt: null, isBot: false, verifiedStatus: { not: 'none' } } } } },
      },
    } });
  }

  /** Any visible, unmuted channel with messages the viewer has not read (the Channels-tab dot). */
  async hasUnread(userId: string, groupId: string) {
    if (!this.enabled(groupId)) return false;
    const rows = await this.prisma.$queryRaw<Array<{ unread: boolean }>>(Prisma.sql`
      SELECT EXISTS (
        SELECT 1 FROM "GroupChannel" c
        LEFT JOIN "GroupChannelViewerState" v ON v."channelId" = c.id AND v."userId" = ${userId}
        WHERE c."groupId" = ${groupId} AND c."archivedAt" IS NULL
          AND (c.privacy = 'normal' OR EXISTS (
            SELECT 1 FROM "GroupChannelAccess" a WHERE a."channelId" = c.id AND a."userId" = ${userId}))
          AND COALESCE(v.preference, 'mentions') <> 'off'
          AND NOT (v."mutedUntil" IS NOT NULL AND v."mutedUntil" > NOW())
          AND EXISTS (
            SELECT 1 FROM "Message" m
            LEFT JOIN "GroupChannelThreadState" t ON t."rootMessageId" = m."threadRootId" AND t."userId" = ${userId}
            WHERE m."conversationId" = c."conversationId" AND NOT m."deletedForAll"
              AND m."senderId" <> ${userId} AND m."channelSequence" > COALESCE(v."readThrough", 0)
              AND (m."threadRootId" IS NULL OR m."channelSequence" > COALESCE(t."readThrough", 0))
          )
      ) AS unread
    `);
    return rows[0]?.unread === true;
  }

  async recipients(groupId: string, channelId: string, db: Prisma.TransactionClient = this.prisma) {
    const channel = await db.groupChannel.findUnique({ where: { id: channelId } });
    if (!channel || channel.groupId !== groupId || !this.enabled(groupId)) return [];
    return db.communityGroupMember.findMany({
      where: { groupId, status: 'active', group: { deletedAt: null }, user: {
        bannedAt: null, isBot: false,
        verifiedStatus: { not: 'none' },
        ...(channel.privacy === 'private' ? { channelAccess: { some: { channelId } } } : {}),
      } },
      select: { userId: true, role: true },
    });
  }
}
