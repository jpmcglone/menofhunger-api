import { BadRequestException, ConflictException, ForbiddenException, Injectable, NotFoundException } from '@nestjs/common';
import { SideEffectsService } from '../side-effects/side-effects.service';
import { createHash } from 'node:crypto';
import { Prisma } from '@prisma/client';
import { findReactionById } from '../../common/constants/reactions';
import { PrismaService } from '../prisma/prisma.service';
import { ChannelAccessService } from './channel-access.service';
import { ChannelAttentionService } from './channel-attention.service';
import { ChannelMediaService } from './channel-media.service';
import { assertChannelSend, isChannelLeader } from './channel-policy';
import { MAX_HIDDEN_PREVIEWS, MESSAGE_INCLUDE, WELCOME_PREFIX } from './channel-message-rows';
import { ChannelMessageReadService } from './channel-message-read.service';

import { canonicalChannelBody } from './channel-references';

export const CHANNEL_MAX_ATTACHMENTS = 4;
export type ChannelAttachmentInput = { uploadId: string; thumbnailUploadId?: string; alt?: string };
export type ChannelSendInput = {
  body: string;
  clientRequestId: string;
  threadRootId?: string;
  replyToId?: string;
  uploadId?: string;
  thumbnailUploadId?: string;
  alt?: string;
  attachments?: ChannelAttachmentInput[];
  giphy?: { url: string; mp4Url?: string; width?: number; height?: number };
};

@Injectable()
export class ChannelMessagesService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly access: ChannelAccessService,
    private readonly attention: ChannelAttentionService,
    private readonly reader: ChannelMessageReadService,
    private readonly media: ChannelMediaService,
    private readonly effects: SideEffectsService,
  ) {}

  async send(userId: string, groupId: string, channelId: string, input: ChannelSendInput) {
    const body = input.body.trim();
    const attachments: ChannelAttachmentInput[] =
      input.attachments ?? (input.uploadId ? [{ uploadId: input.uploadId, thumbnailUploadId: input.thumbnailUploadId, alt: input.alt }] : []);
    if (
      attachments.length > CHANNEL_MAX_ATTACHMENTS ||
      new Set(attachments.map((item) => item.uploadId)).size !== attachments.length ||
      (attachments.length && input.giphy)
    )
      throw new BadRequestException(`Attach up to ${CHANNEL_MAX_ATTACHMENTS} items.`);
    if ((!body && !attachments.length && !input.giphy) || body.length > 2000) throw new BadRequestException('Write a message of up to 2,000 characters.');
    const requestHash = createHash('sha256')
      .update(
        JSON.stringify({
          body,
          threadRootId: input.threadRootId ?? null,
          ...(input.replyToId ? { replyToId: input.replyToId } : {}),
          uploadId: input.uploadId ?? null,
          thumbnailUploadId: input.thumbnailUploadId ?? null,
          alt: input.alt ?? null,
          giphy: input.giphy ?? null,
          ...(input.attachments ? { attachments: input.attachments } : {}),
        }),
      )
      .digest('hex');
    let createdNow = false;
    const message = await this.prisma.$transaction(async (tx) => {
      await this.access.lockGroup(tx, groupId);
      const { channel, member } = await this.access.channel(userId, groupId, channelId, tx);
      const existing = await tx.message.findUnique({
        where: {
          conversationId_senderId_clientRequestId: {
            conversationId: channel.conversationId,
            senderId: userId,
            clientRequestId: input.clientRequestId,
          },
        },
        include: MESSAGE_INCLUDE,
      });
      if (existing) {
        if (existing.requestHash !== requestHash) throw new ConflictException('This request ID was already used for a different message.');
        return existing;
      }
      assertChannelSend(channel, member.role);
      const canonicalBody = await canonicalChannelBody(tx, userId, groupId, body);
      const threadRootId = input.threadRootId ? await this.reader.requireRoot(channel.conversationId, input.threadRootId, tx) : null;
      // Inline quoted reply: the target must be a live message in this same channel.
      const replyToId = input.replyToId
        ? ((
            await tx.message.findFirst({
              where: {
                id: input.replyToId,
                conversationId: channel.conversationId,
                deletedForAll: false,
                channelSequence: { not: null },
              },
              select: { id: true },
            })
          )?.id ?? null)
        : null;
      if (input.replyToId && !replyToId) throw new BadRequestException('That message is no longer available to reply to.');
      const uploaded = [];
      for (const item of attachments)
        uploaded.push({
          ...(await this.media.consume(tx, userId, channelId, item.uploadId, item.thumbnailUploadId)),
          alt: item.alt ?? null,
        });
      const media = uploaded.length
        ? uploaded
        : input.giphy
          ? [{ source: 'giphy' as const, kind: 'gif' as const, ...input.giphy, alt: input.alt ?? null }]
          : [];
      const updated = await tx.groupChannel.update({
        where: { id: channelId },
        data: { lastSequence: { increment: 1 }, revision: { increment: 1 } },
      });
      const created = await tx.message.create({
        data: {
          conversationId: channel.conversationId,
          senderId: userId,
          body: canonicalBody,
          clientRequestId: input.clientRequestId,
          requestHash,
          channelRevision: updated.revision,
          channelSequence: updated.lastSequence,
          threadRootId,
          replyToId,
          ...(media.length ? { media: { create: media } } : {}),
        },
        include: MESSAGE_INCLUDE,
      });
      if (threadRootId) await tx.message.update({ where: { id: threadRootId }, data: { channelRevision: updated.revision } });
      const rootMessageId = threadRootId ?? created.id;
      await tx.groupChannelThreadState.upsert({
        where: { rootMessageId_userId: { rootMessageId, userId } },
        create: { rootMessageId, userId, following: true },
        update: {},
      });
      await tx.groupChannelThreadState.updateMany({
        where: { rootMessageId, userId, unfollowed: false },
        data: { following: true },
      });
      await this.attention.reconcile(tx, {
        groupId,
        channelId,
        messageId: created.id,
        senderId: userId,
        body: canonicalBody,
        threadRootId,
        broadcast: isChannelLeader(member.role),
      });
      createdNow = true;
      return created;
    });
    await this.reader.broadcast(groupId, channelId, message.id);
    const result = (await this.reader.present(userId, groupId, channelId, [message]))[0];
    if (createdNow)
      this.effects.dispatch(
        'channel.marv.request',
        { groupId, channelId, messageId: message.id, requesterId: userId },
        { jobId: `channel-marv-${message.id}` },
      );
    if (createdNow && Array.isArray(message.media) && message.media.some((item) => item.kind === 'audio'))
      this.effects.dispatch('media.transcribe.request', { messageId: message.id }, { jobId: `transcribe-${message.id}` });
    if (createdNow)
      this.effects.dispatch('channel.message.changed', { groupId, channelId, messageId: message.id, edited: false }, { jobId: `channel-send-${message.id}` });
    return result;
  }

  /**
   * Records a new member in the group's #general as a `groupJoin` system row. Idempotent per join
   * time, so queue retries never duplicate it. It is silent: no push, badge, mention or unread dot.
   */
  async recordJoin(groupId: string, userId: string, at: string) {
    if (!this.access.enabled(groupId)) return;
    const clientRequestId = `join:${at}`;
    const created = await this.prisma.$transaction(async (tx) => {
      await this.access.lockGroup(tx, groupId);
      const channel = await tx.groupChannel.findUnique({
        where: { groupId_defaultPurpose: { groupId, defaultPurpose: 'general' } },
      });
      if (!channel || channel.archivedAt) return null;
      const member = await tx.communityGroupMember.findUnique({
        where: { groupId_userId: { groupId, userId } },
        include: { user: { select: { bannedAt: true, isBot: true, verifiedStatus: true } } },
      });
      if (!member || member.status !== 'active' || member.user.bannedAt || member.user.isBot || member.user.verifiedStatus === 'none') return null;
      if (
        await tx.message.findFirst({
          where: {
            conversationId: channel.conversationId,
            senderId: userId,
            kind: 'groupJoin',
            OR: [{ clientRequestId }, { createdAt: { gt: new Date(Date.now() - 60_000) } }],
          },
          select: { id: true },
        })
      )
        return null;
      const updated = await tx.groupChannel.update({
        where: { id: channel.id },
        data: { lastSequence: { increment: 1 }, revision: { increment: 1 } },
      });
      const message = await tx.message.create({
        data: {
          conversationId: channel.conversationId,
          senderId: userId,
          body: '',
          kind: 'groupJoin',
          clientRequestId,
          channelRevision: updated.revision,
          channelSequence: updated.lastSequence,
        },
      });
      return { channelId: channel.id, messageId: message.id };
    });
    if (created) await this.reader.broadcast(groupId, created.channelId, created.messageId);
  }

  /** Welcome button: posts "Welcome, <first name> 🤝" as the viewer (once per join row), then hides the button for them. */
  async welcome(userId: string, groupId: string, channelId: string, messageId: string) {
    const { channel } = await this.access.channel(userId, groupId, channelId);
    const join = await this.prisma.message.findFirst({
      where: { id: messageId, conversationId: channel.conversationId, kind: 'groupJoin', deletedForAll: false },
      include: { sender: { select: { name: true, username: true } } },
    });
    if (!join) throw new NotFoundException('Message unavailable.');
    if (join.senderId === userId) throw new BadRequestException('You cannot welcome yourself.');
    const first = join.sender.name?.trim().split(/\s+/)[0] || join.sender.username || 'friend';
    const message = await this.send(userId, groupId, channelId, {
      body: `Welcome, ${first} 🤝`,
      clientRequestId: `${WELCOME_PREFIX}${join.id}`,
    });
    await this.prisma.$transaction(async (tx) => {
      await this.access.lockGroup(tx, groupId);
      await this.advanceRevision(tx, channelId, join.id);
    });
    await this.reader.broadcast(groupId, channelId, join.id);
    return message;
  }

  private async advanceRevision(tx: Prisma.TransactionClient, channelId: string, messageId: string, rootId?: string | null) {
    const channel = await tx.groupChannel.update({ where: { id: channelId }, data: { revision: { increment: 1 } } });
    await tx.message.updateMany({
      where: { id: { in: rootId ? [messageId, rootId] : [messageId] } },
      data: { channelRevision: channel.revision },
    });
  }

  /** Publish a server-side change to message media (for example a finished transcript) as a new revision. */
  async publishMediaChange(groupId: string, channelId: string, messageId: string) {
    const message = await this.prisma.message.findUnique({ where: { id: messageId }, select: { threadRootId: true } });
    await this.prisma.$transaction(async (tx) => {
      await this.access.lockGroup(tx, groupId);
      await this.advanceRevision(tx, channelId, messageId, message?.threadRootId);
    });
    await this.reader.broadcast(groupId, channelId, messageId);
  }

  async edit(userId: string, groupId: string, channelId: string, messageId: string, body: string) {
    await this.prisma.$transaction(async (tx) => {
      await this.access.lockGroup(tx, groupId);
      const { channel, member } = await this.access.channel(userId, groupId, channelId, tx);
      assertChannelSend(channel, member.role);
      const message = await tx.message.findFirst({
        where: {
          id: messageId,
          conversationId: channel.conversationId,
          senderId: userId,
          deletedForAll: false,
          kind: 'text',
        },
      });
      if (!message || Date.now() - message.createdAt.getTime() >= 15 * 60_000) throw new ForbiddenException('This message can no longer be edited.');
      const canonicalBody = await canonicalChannelBody(tx, userId, groupId, body, message.body);
      await this.advanceRevision(tx, channelId, messageId);
      const hiddenPreviews = message.hiddenPreviews.filter((url) => body.includes(url));
      await tx.message.update({ where: { id: messageId }, data: { body: canonicalBody, hiddenPreviews, editedAt: new Date() } });
      await this.attention.reconcile(tx, {
        groupId,
        channelId,
        messageId,
        senderId: userId,
        body: canonicalBody,
        threadRootId: message.threadRootId,
        edited: true,
        broadcast: isChannelLeader(member.role),
      });
    });
    await this.reader.broadcast(groupId, channelId, messageId);
    this.effects.dispatch('channel.message.changed', { groupId, channelId, messageId, edited: true });
  }

  /** The author removes (or restores) the rich preview of one link in their own message. */
  async hidePreview(userId: string, groupId: string, channelId: string, messageId: string, url: string, hidden: boolean) {
    await this.prisma.$transaction(async (tx) => {
      await this.access.lockGroup(tx, groupId);
      const { channel, member } = await this.access.channel(userId, groupId, channelId, tx);
      assertChannelSend(channel, member.role);
      const message = await tx.message.findFirst({
        where: {
          id: messageId,
          conversationId: channel.conversationId,
          senderId: userId,
          deletedForAll: false,
          kind: 'text',
        },
      });
      if (!message) throw new ForbiddenException('Only the author can remove previews.');
      if (!message.body.includes(url)) throw new BadRequestException('That link is not in this message.');
      const rest = message.hiddenPreviews.filter((item) => item !== url);
      const next = hidden ? [...rest, url].slice(-MAX_HIDDEN_PREVIEWS) : rest;
      if (next.length === message.hiddenPreviews.length && next.every((item) => message.hiddenPreviews.includes(item))) return;
      await this.advanceRevision(tx, channelId, messageId, message.threadRootId);
      await tx.message.update({ where: { id: messageId }, data: { hiddenPreviews: next } });
    });
    await this.reader.broadcast(groupId, channelId, messageId);
  }

  async delete(userId: string, groupId: string, channelId: string, messageId: string) {
    await this.prisma.$transaction(async (tx) => {
      await this.access.lockGroup(tx, groupId);
      const { channel, member } = await this.access.channel(userId, groupId, channelId, tx);
      if (channel.archivedAt) throw new ForbiddenException('This channel is archived.');
      const message = await tx.message.findFirst({ where: { id: messageId, conversationId: channel.conversationId } });
      if (!message || (message.senderId !== userId && !isChannelLeader(member.role))) throw new ForbiddenException('You cannot delete this message.');
      await this.advanceRevision(tx, channelId, messageId, message.threadRootId);
      await tx.message.update({
        where: { id: messageId },
        data: { deletedForAll: true, deletedForAllAt: new Date(), body: '' },
      });
      await tx.groupChannelPin.deleteMany({ where: { messageId } });
      await tx.groupChannelAttention.deleteMany({ where: { messageId } });
      await tx.marvinMemorySource.deleteMany({ where: { messageId } });
    });
    await this.reader.broadcast(groupId, channelId, messageId);
    this.effects.dispatch('channel.message.changed', { groupId, channelId, messageId, edited: true });
  }

  async reaction(userId: string, groupId: string, channelId: string, messageId: string, reactionId: string, add: boolean) {
    const reaction = findReactionById(reactionId);
    if (!reaction) throw new BadRequestException('Unknown reaction.');
    await this.prisma.$transaction(async (tx) => {
      await this.access.lockGroup(tx, groupId);
      const { channel } = await this.access.channel(userId, groupId, channelId, tx);
      if (channel.archivedAt) throw new ForbiddenException('This channel is archived.');
      const message = await tx.message.findFirst({
        where: { id: messageId, conversationId: channel.conversationId, deletedForAll: false },
      });
      if (!message) throw new NotFoundException('Message unavailable.');
      await this.advanceRevision(tx, channelId, messageId);
      if (add)
        await tx.messageReaction.upsert({
          where: { messageId_userId_reactionId: { messageId, userId, reactionId } },
          create: { messageId, userId, reactionId, emoji: reaction.emoji },
          update: {},
        });
      else await tx.messageReaction.deleteMany({ where: { messageId, userId, reactionId } });
    });
    await this.reader.broadcast(groupId, channelId, messageId);
  }

  async pin(userId: string, groupId: string, channelId: string, messageId: string, pinned: boolean) {
    await this.prisma.$transaction(async (tx) => {
      await this.access.lockGroup(tx, groupId);
      const { channel, member } = await this.access.channel(userId, groupId, channelId, tx);
      if (channel.archivedAt || !isChannelLeader(member.role)) throw new ForbiddenException('Only leaders can change pins in an active channel.');
      const message = await tx.message.findFirst({
        where: { id: messageId, conversationId: channel.conversationId, deletedForAll: false },
      });
      if (!message) throw new NotFoundException('Message unavailable.');
      await this.advanceRevision(tx, channelId, messageId);
      if (pinned)
        await tx.groupChannelPin.upsert({
          where: { channelId_messageId: { channelId, messageId } },
          create: { channelId, messageId, pinnedByUserId: userId },
          update: {},
        });
      else await tx.groupChannelPin.deleteMany({ where: { channelId, messageId } });
    });
    await this.reader.broadcast(groupId, channelId, messageId);
  }

}
