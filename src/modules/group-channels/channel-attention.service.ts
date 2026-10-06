import { SideEffectsService } from '../side-effects/side-effects.service';
import { BadRequestException, Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { parseMentionsFromBody } from '../../common/mentions/mention-regex';
import { PrismaService } from '../prisma/prisma.service';
import { ChannelAccessService } from './channel-access.service';
import { ChannelsService } from './channels.service';

@Injectable()
export class ChannelAttentionService {
  constructor(private readonly prisma: PrismaService, private readonly access: ChannelAccessService, private readonly channels: ChannelsService, private readonly effects: SideEffectsService) {}

  /** Called inside the message transaction; one row holds both personal reasons. */
  async reconcile(tx: Prisma.TransactionClient, input: { groupId: string; channelId: string; messageId: string; senderId: string; body: string; threadRootId: string | null; edited?: boolean }) {
    const eligible = (await this.access.recipients(input.groupId, input.channelId, tx)).map(m => m.userId).filter(id => id !== input.senderId);
    const previous = await tx.groupChannelAttention.findMany({ where: { messageId: input.messageId }, select: { userId: true, mentioned: true } });
    const priorMentions = new Set(previous.filter(row => row.mentioned).map(row => row.userId));
    const mentions = parseMentionsFromBody(input.body);
    const mentioned = mentions.length ? await tx.user.findMany({ where: { id: { in: eligible }, OR: mentions.map(username => ({ username: { equals: username, mode: 'insensitive' as const } })) }, select: { id: true } }) : [];
    const mentionedIds = new Set(mentioned.map(u => u.id));
    const followed = input.threadRootId && !input.edited ? await tx.groupChannelThreadState.findMany({ where: { rootMessageId: input.threadRootId, following: true, userId: { in: eligible } }, select: { userId: true } }) : [];
    // An edit can remove a mention without erasing an independent followed-reply reason.
    await tx.groupChannelAttention.updateMany({ where: { messageId: input.messageId, userId: { notIn: [...mentionedIds] } }, data: { mentioned: false } });
    await tx.groupChannelAttention.deleteMany({ where: { messageId: input.messageId, mentioned: false, followedReply: false } });
    const followedIds = new Set(followed.map(u => u.userId));
    const recipients = new Set([...mentionedIds, ...followedIds]);
    for (const userId of recipients) {
      await tx.groupChannelAttention.upsert({
        where: { messageId_userId: { messageId: input.messageId, userId } },
        create: { channelId: input.channelId, messageId: input.messageId, userId, mentioned: mentionedIds.has(userId), followedReply: followedIds.has(userId) },
        // Preserve read state when an edit repeats a mention; no duplicate alert.
        update: { mentioned: mentionedIds.has(userId), ...(input.edited && mentionedIds.has(userId) && !priorMentions.has(userId) ? { readAt: null } : {}), ...(!input.edited ? { followedReply: followedIds.has(userId) } : {}) },
      });
    }
  }

  async acknowledge(userId: string, groupId: string, channelId: string, input: { messageIds: string[]; through?: number; threadRootId?: string }) {
    let from = 0;
    const acknowledged = await this.prisma.$transaction(async tx => {
      await this.access.lockGroup(tx, groupId);
      const { channel } = await this.access.channel(userId, groupId, channelId, tx);
      if (input.through !== undefined && input.through > channel.lastSequence) throw new BadRequestException('Invalid reading position.');
      const viewed = await tx.message.findMany({ where: { id: { in: input.messageIds }, conversationId: channel.conversationId }, select: { id: true } });
      await tx.groupChannelAttention.updateMany({ where: { userId, channelId, messageId: { in: viewed.map(m => m.id) }, readAt: null }, data: { readAt: new Date() } });
      if (input.through !== undefined) {
        if (input.threadRootId) {
          const root = await tx.message.findFirst({ where: { id: input.threadRootId, conversationId: channel.conversationId, threadRootId: null } });
          if (!root) throw new BadRequestException('Thread unavailable.');
          from = (await tx.groupChannelThreadState.findUnique({ where: { rootMessageId_userId: { rootMessageId: root.id, userId } }, select: { readThrough: true } }))?.readThrough ?? 0;
          await tx.groupChannelThreadState.upsert({ where: { rootMessageId_userId: { rootMessageId: root.id, userId } }, create: { rootMessageId: root.id, userId, following: false, readThrough: input.through }, update: {} });
          await tx.groupChannelThreadState.updateMany({ where: { rootMessageId: root.id, userId, readThrough: { lt: input.through } }, data: { readThrough: input.through } });
        } else {
          from = (await tx.groupChannelViewerState.findUnique({ where: { channelId_userId: { channelId, userId } }, select: { readThrough: true } }))?.readThrough ?? 0;
          await tx.groupChannelViewerState.upsert({ where: { channelId_userId: { channelId, userId } }, create: { channelId, userId, readThrough: input.through }, update: {} });
          await tx.groupChannelViewerState.updateMany({ where: { channelId, userId, readThrough: { lt: input.through } }, data: { readThrough: input.through } });
        }
      }
      return viewed.map(message => message.id);
    });
    await this.channels.viewerChanged(userId, groupId, channelId, { readMessageIds: acknowledged, readThrough: input.through, threadRootId: input.threadRootId });
    this.effects.dispatch('notification.badge.sync', { recipientUserId: userId });
    this.effects.dispatch('account.cluster.badge', { userId });
    return input.through !== undefined && input.through > from ? { from, through: input.through, threadRootId: input.threadRootId } : null;
  }

  async preference(userId: string, groupId: string, channelId: string, preference: 'all' | 'mentions' | 'off') {
    await this.prisma.$transaction(async tx => {
      await this.access.lockGroup(tx, groupId);
      await this.access.channel(userId, groupId, channelId, tx);
      await tx.groupChannelViewerState.upsert({ where: { channelId_userId: { channelId, userId } }, create: { channelId, userId, preference }, update: { preference } });
    });
    await this.channels.viewerChanged(userId, groupId, channelId);
  }

  /** Mutes silences activity dots and ordinary delivery; mentions still reach the member. */
  async mute(userId: string, groupId: string, channelId: string, until: Date | null) {
    await this.prisma.$transaction(async tx => {
      await this.access.lockGroup(tx, groupId);
      await this.access.channel(userId, groupId, channelId, tx);
      await tx.groupChannelViewerState.upsert({ where: { channelId_userId: { channelId, userId } }, create: { channelId, userId, mutedUntil: until }, update: { mutedUntil: until } });
    });
    await this.channels.viewerChanged(userId, groupId, channelId);
    this.effects.dispatch('account.cluster.badge', { userId });
  }

  async hide(userId: string, groupId: string, channelId: string, hidden: boolean) {
    await this.prisma.$transaction(async tx => {
      await this.access.lockGroup(tx, groupId);
      await this.access.channel(userId, groupId, channelId, tx);
      await tx.groupChannelViewerState.upsert({ where: { channelId_userId: { channelId, userId } }, create: { channelId, userId, hidden }, update: { hidden } });
    });
    await this.channels.viewerChanged(userId, groupId, channelId);
  }

  /** Marks everything in the channel (and its threads) read, including personal attention. */
  async markAllRead(userId: string, groupId: string, channelId: string) {
    const advanced = await this.prisma.$transaction(async tx => {
      await this.access.lockGroup(tx, groupId);
      const { channel } = await this.access.channel(userId, groupId, channelId, tx);
      const from = (await tx.groupChannelViewerState.findUnique({ where: { channelId_userId: { channelId, userId } }, select: { readThrough: true } }))?.readThrough ?? 0;
      await tx.groupChannelViewerState.upsert({ where: { channelId_userId: { channelId, userId } }, create: { channelId, userId, readThrough: channel.lastSequence }, update: {} });
      await tx.groupChannelViewerState.updateMany({ where: { channelId, userId, readThrough: { lt: channel.lastSequence } }, data: { readThrough: channel.lastSequence } });
      await tx.groupChannelAttention.updateMany({ where: { userId, channelId, readAt: null }, data: { readAt: new Date() } });
      await tx.groupChannelThreadState.updateMany({ where: { userId, root: { conversationId: channel.conversationId }, readThrough: { lt: channel.lastSequence } }, data: { readThrough: channel.lastSequence } });
      return channel.lastSequence > from ? { from, through: channel.lastSequence } : null;
    });
    await this.channels.viewerChanged(userId, groupId, channelId, { readThrough: advanced?.through });
    this.effects.dispatch('notification.badge.sync', { recipientUserId: userId });
    this.effects.dispatch('account.cluster.badge', { userId });
    return advanced;
  }

  async markUnread(userId: string, groupId: string, channelId: string, messageId: string) {
    await this.prisma.$transaction(async tx => {
      await this.access.lockGroup(tx, groupId);
      const { channel } = await this.access.channel(userId, groupId, channelId, tx);
      const message = await tx.message.findFirst({ where: { id: messageId, conversationId: channel.conversationId } });
      if (!message?.channelSequence) throw new BadRequestException('Message unavailable.');
      const readThrough = message.channelSequence - 1;
      if (message.threadRootId) {
        await tx.groupChannelThreadState.updateMany({ where: { rootMessageId: message.threadRootId, userId }, data: { readThrough } });
      }
      await tx.groupChannelViewerState.upsert({ where: { channelId_userId: { channelId, userId } }, create: { channelId, userId, readThrough }, update: { readThrough } });
    });
    await this.channels.viewerChanged(userId, groupId, channelId);
  }

  async follow(userId: string, groupId: string, channelId: string, rootMessageId: string, following: boolean) {
    await this.prisma.$transaction(async tx => {
      await this.access.lockGroup(tx, groupId);
      const { channel } = await this.access.channel(userId, groupId, channelId, tx);
      const root = await tx.message.findFirst({ where: { id: rootMessageId, conversationId: channel.conversationId, threadRootId: null } });
      if (!root) throw new BadRequestException('Thread unavailable.');
      await tx.groupChannelThreadState.upsert({ where: { rootMessageId_userId: { rootMessageId, userId } }, create: { rootMessageId, userId, following, unfollowed: !following }, update: { following, unfollowed: !following } });
    });
    await this.channels.viewerChanged(userId, groupId, channelId, { threadRootId: rootMessageId, following });
  }
}
