import { BadRequestException, ConflictException, ForbiddenException, Injectable, NotFoundException } from '@nestjs/common';
import { SideEffectsService } from '../side-effects/side-effects.service';
import { createHash } from 'node:crypto';
import { Prisma } from '@prisma/client';
import { USER_LIST_SELECT } from '../../common/prisma-selects/user.select';
import { findReactionById } from '../../common/constants/reactions';
import type { GroupChannelMessageDto, GroupChannelReceiptDto } from '../../common/dto/group-channel.dto';
import { toMessageDto, transcriptFields } from '../messages/message.dto';
import { PresenceRealtimeService } from '../presence/presence-realtime.service';
import { AppConfigService } from '../app/app-config.service';
import { PrismaService } from '../prisma/prisma.service';
import { ChannelAccessService } from './channel-access.service';
import { ChannelAttentionService } from './channel-attention.service';
import { ChannelsService } from './channels.service';
import { ChannelMediaService } from './channel-media.service';
import { assertChannelSend, channelCapabilities, isChannelLeader } from './channel-policy';
import { personalChannelMessageWhere } from './channel-attention-policy';

const MAX_HIDDEN_PREVIEWS = 10;
const MESSAGE_INCLUDE = {
  sender: { select: USER_LIST_SELECT },
  reactions: { include: { user: { select: USER_LIST_SELECT } }, orderBy: { createdAt: 'asc' as const } },
  media: { orderBy: [{ createdAt: 'asc' as const }, { id: 'asc' as const }] },
  channelPins: true,
  replyTo: { include: { sender: { select: { username: true } }, media: { orderBy: [{ createdAt: 'asc' as const }, { id: 'asc' as const }] } } },
  threadReplies: { where: { deletedForAll: false }, select: { createdAt: true }, orderBy: { createdAt: 'desc' as const }, take: 1 },
  _count: { select: { threadReplies: { where: { deletedForAll: false } } } },
} satisfies Prisma.MessageInclude;
type MessageRow = Prisma.MessageGetPayload<{ include: typeof MESSAGE_INCLUDE }>;
/** A deleted message stays visible only as the placeholder root of replies that remain. */
const VISIBLE_MESSAGE = { OR: [{ deletedForAll: false }, { threadRootId: null, threadReplies: { some: { deletedForAll: false } } }] } satisfies Prisma.MessageWhereInput;
export const CHANNEL_MAX_ATTACHMENTS = 4;
const WELCOME_PREFIX = 'welcome:';
export type ChannelAttachmentInput = { uploadId: string; thumbnailUploadId?: string; alt?: string };
export type ChannelSendInput = { body: string; clientRequestId: string; threadRootId?: string; replyToId?: string; uploadId?: string; thumbnailUploadId?: string; alt?: string; attachments?: ChannelAttachmentInput[]; giphy?: { url: string; mp4Url?: string; width?: number; height?: number } };

@Injectable()
export class ChannelMessagesService {
  constructor(private readonly prisma: PrismaService, private readonly access: ChannelAccessService, private readonly channels: ChannelsService, private readonly attention: ChannelAttentionService, private readonly config: AppConfigService, private readonly realtime: PresenceRealtimeService, private readonly media: ChannelMediaService, private readonly effects: SideEffectsService) {}

  private async present(userId: string, groupId: string, channelId: string, rows: MessageRow[]): Promise<GroupChannelMessageDto[]> {
    // Recheck after the query as well: a slow read must not return content after revocation.
    const { channel, member } = await this.access.channel(userId, groupId, channelId);
    const roots = rows.map(m => m.threadRootId ?? m.id);
    const states = await this.prisma.groupChannelThreadState.findMany({ where: { userId, rootMessageId: { in: roots } } });
    const follows = new Set(states.filter(s => s.following).map(s => s.rootMessageId));
    const receipts = await this.receipts(userId, groupId, channel, rows);
    const welcomes = await this.welcomes(rows);
    return this.render(userId, member.role, groupId, channel, rows, follows, receipts, welcomes.get(userId));
  }

  private render(userId: string, role: Parameters<typeof channelCapabilities>[1], groupId: string, channel: Parameters<typeof channelCapabilities>[0] & { id: string }, rows: MessageRow[], follows: Set<string>, receipts: Map<string, GroupChannelReceiptDto>, welcomed: Set<string> = new Set()): GroupChannelMessageDto[] {
    const channelId = channel.id;
    const member = { role };
    return rows.map(message => ({
      receipt: receipts.get(message.id) ?? null,
      ...toMessageDto({ message: { ...message, media: [] }, publicBaseUrl: this.config.r2()?.publicBaseUrl ?? null, viewerUserId: userId }),
      // Uploaded channel media is never mapped through the public Chat URL resolver.
      media: message.deletedForAll ? [] : message.media.map(media => ({
        id: media.id, kind: media.kind, source: media.source,
        url: media.source === 'upload' ? `/groups/${groupId}/channels/${channelId}/media/${media.id}` : media.url ?? '',
        thumbnailUrl: media.thumbnailR2Key ? `/groups/${groupId}/channels/${channelId}/media/${media.id}?thumbnail=true` : null,
        mp4Url: media.source === 'upload' ? null : media.mp4Url,
        width: media.width, height: media.height, durationSeconds: media.durationSeconds === null ? null : Math.floor(media.durationSeconds), alt: media.alt, ...transcriptFields(media),
      })),
      clientRequestId: message.senderId === userId ? message.clientRequestId : null,
      revision: message.channelRevision,
      channelId, sequence: message.channelSequence!, threadRootId: message.threadRootId,
      hiddenPreviews: message.deletedForAll ? [] : message.hiddenPreviews,
      replyCount: message._count.threadReplies, lastReplyAt: message.threadReplies[0]?.createdAt.toISOString() ?? null,
      following: follows.has(message.threadRootId ?? message.id), pinned: message.channelPins.length > 0 && !message.deletedForAll,
      joinWelcome: message.kind === 'groupJoin' && !message.deletedForAll
        ? { canWelcome: message.senderId !== userId && !welcomed.has(message.id) && !channel.archivedAt && channelCapabilities(channel, member.role).canSend }
        : null,
      canEdit: message.kind === 'text' && channelCapabilities(channel, member.role).canSend && !message.deletedForAll && message.senderId === userId && Date.now() - message.createdAt.getTime() < 15 * 60_000,
      canDelete: !channel.archivedAt && !message.deletedForAll && (message.senderId === userId || isChannelLeader(member.role)),
    }));
  }

  /** Who already welcomed each join row: member ID -> join message IDs. A welcome is the member's own `welcome:<joinId>` message. */
  private async welcomes(rows: MessageRow[]) {
    const byUser = new Map<string, Set<string>>();
    const joins = rows.filter(message => message.kind === 'groupJoin' && !message.deletedForAll);
    if (!joins.length) return byUser;
    const sent = await this.prisma.message.findMany({
      where: { conversationId: { in: [...new Set(joins.map(message => message.conversationId))] }, deletedForAll: false, clientRequestId: { in: joins.map(message => `${WELCOME_PREFIX}${message.id}`) } },
      select: { senderId: true, clientRequestId: true },
    });
    for (const item of sent) byUser.set(item.senderId, (byUser.get(item.senderId) ?? new Set()).add(item.clientRequestId!.slice(WELCOME_PREFIX.length)));
    return byUser;
  }

  /**
   * Read counts for the viewer's own messages. A top-level message is read once a member's channel
   * position passes it; a reply once their position in that thread does. The sender is never counted.
   */
  private async receipts(userId: string, groupId: string, channel: { id: string; privacy: string }, rows: MessageRow[], known?: Array<{ userId: string }>) {
    const own = rows.filter(message => message.senderId === userId && !message.deletedForAll && message.channelSequence);
    const result = new Map<string, GroupChannelReceiptDto>();
    if (!own.length) return result;
    const eligible = Prisma.sql`
      JOIN "CommunityGroupMember" gm ON gm."groupId" = ${groupId} AND gm."userId" = r."userId" AND gm.status = 'active'
      JOIN "User" u ON u.id = r."userId" AND u."bannedAt" IS NULL AND NOT u."isBot" AND u."verifiedStatus" <> 'none'
      ${channel.privacy === 'private' ? Prisma.sql`JOIN "GroupChannelAccess" a ON a."channelId" = ${channel.id} AND a."userId" = r."userId"` : Prisma.empty}`;
    const top = own.filter(message => !message.threadRootId).map(message => message.id);
    const replies = own.filter(message => message.threadRootId).map(message => message.id);
    const [recipients, topCounts, replyCounts] = await Promise.all([
      known ?? this.access.recipients(groupId, channel.id),
      top.length ? this.prisma.$queryRaw<Array<{ id: string; reads: number }>>(Prisma.sql`
        SELECT m.id, COUNT(*)::int AS reads FROM "Message" m
        JOIN "GroupChannelViewerState" r ON r."channelId" = ${channel.id} AND r."userId" <> m."senderId" AND r."readThrough" >= m."channelSequence"
        ${eligible}
        WHERE m.id IN (${Prisma.join(top)}) GROUP BY m.id`) : [],
      replies.length ? this.prisma.$queryRaw<Array<{ id: string; reads: number }>>(Prisma.sql`
        SELECT m.id, COUNT(*)::int AS reads FROM "Message" m
        JOIN "GroupChannelThreadState" r ON r."rootMessageId" = m."threadRootId" AND r."userId" <> m."senderId" AND r."readThrough" >= m."channelSequence"
        ${eligible}
        WHERE m.id IN (${Prisma.join(replies)}) GROUP BY m.id`) : [],
    ]);
    const reads = new Map([...topCounts, ...replyCounts].map(row => [row.id, row.reads]));
    const recipientCount = Math.max(recipients.filter(member => member.userId !== userId).length, 0);
    for (const message of own) result.set(message.id, { readCount: Math.min(reads.get(message.id) ?? 0, recipientCount), recipientCount });
    return result;
  }

  /** Tells each sender that someone newly read their messages by re-sending their canonical snapshots. */
  async broadcastReceipts(groupId: string, channelId: string, readerId: string, range: { from: number; through: number; threadRootId?: string }) {
    if (range.through <= range.from) return;
    const channel = await this.prisma.groupChannel.findUnique({ where: { id: channelId } });
    if (!channel) return;
    const rows = await this.prisma.message.findMany({
      where: { conversationId: channel.conversationId, deletedForAll: false, senderId: { not: readerId }, threadRootId: range.threadRootId ?? null, channelSequence: { gt: range.from, lte: range.through } },
      include: MESSAGE_INCLUDE, orderBy: { channelSequence: 'asc' }, take: 100,
    });
    const bySender = new Map<string, MessageRow[]>();
    for (const row of rows) bySender.set(row.senderId, [...(bySender.get(row.senderId) ?? []), row]);
    for (const [senderId, own] of bySender) {
      try {
        const snapshot = await this.channels.details(senderId, groupId, channelId);
        this.realtime.emitGroupChannelMessages(senderId, { groupId, channel: snapshot, messages: await this.present(senderId, groupId, channelId, own) });
      } catch (error) {
        if (!(error instanceof NotFoundException)) throw error;
      }
    }
  }

  async broadcast(groupId: string, channelId: string, messageId: string) {
    const channel = await this.prisma.groupChannel.findUniqueOrThrow({ where: { id: channelId } });
    const message = await this.prisma.message.findFirst({ where: { id: messageId, conversationId: channel.conversationId }, include: MESSAGE_INCLUDE });
    if (!message) return;
    const root = message.threadRootId ? await this.prisma.message.findUnique({ where: { id: message.threadRootId }, include: MESSAGE_INCLUDE }) : null;
    const rows = root ? [root, message] : [message];
    const recipients = await this.access.recipients(groupId, channelId);
    const [snapshots, states] = await Promise.all([
      this.channels.viewerSnapshots(channelId, recipients),
      this.prisma.groupChannelThreadState.findMany({
        where: { userId: { in: recipients.map(r => r.userId) }, rootMessageId: { in: rows.map(m => m.threadRootId ?? m.id) }, following: true },
        select: { userId: true, rootMessageId: true },
      }),
    ]);
    const followsByUser = new Map<string, Set<string>>();
    for (const state of states) followsByUser.set(state.userId, (followsByUser.get(state.userId) ?? new Set()).add(state.rootMessageId));
    const welcomes = await this.welcomes(rows);
    const owners = new Set(rows.map(m => m.senderId));
    const receiptsByOwner = new Map<string, Map<string, GroupChannelReceiptDto>>();
    for (const owner of owners) if (recipients.some(r => r.userId === owner)) receiptsByOwner.set(owner, await this.receipts(owner, groupId, channel, rows, recipients));
    for (const recipient of recipients) {
      const snapshot = snapshots.get(recipient.userId);
      if (!snapshot) continue;
      const messages = this.render(recipient.userId, recipient.role, groupId, channel, rows, followsByUser.get(recipient.userId) ?? new Set(), receiptsByOwner.get(recipient.userId) ?? new Map(), welcomes.get(recipient.userId));
      this.realtime.emitGroupChannelMessages(recipient.userId, { groupId, channel: snapshot, messages });
    }
  }

  async list(userId: string, groupId: string, channelId: string, input: { before?: number; changedSince?: number; root?: string; limit?: number }) {
    const { channel } = await this.access.channel(userId, groupId, channelId);
    const root = input.root ? await this.requireRoot(channel.conversationId, input.root) : null;
    const limit = Math.min(input.limit ?? 40, 100);
    if (input.changedSince !== undefined) {
      // Reconnect catch-up: every send, edit, deletion, reaction and pin advances the message revision.
      // Deleted rows are returned as tombstones so clients can drop them.
      const rows = await this.prisma.message.findMany({
        where: { conversationId: channel.conversationId, threadRootId: root, channelRevision: { gt: input.changedSince } },
        include: MESSAGE_INCLUDE, orderBy: [{ channelRevision: 'asc' }, { id: 'asc' }], take: limit + 1,
      });
      const page = rows.slice(0, limit);
      return { messages: await this.present(userId, groupId, channelId, page), nextCursor: rows.length > limit ? page.at(-1)!.channelRevision : null, latestSequence: channel.lastSequence };
    }
    const rows = await this.prisma.message.findMany({
      where: { conversationId: channel.conversationId, threadRootId: root, ...VISIBLE_MESSAGE, ...(input.before ? { channelSequence: { lt: input.before } } : {}) },
      include: MESSAGE_INCLUDE, orderBy: { channelSequence: 'desc' }, take: limit + 1,
    });
    const more = rows.length > limit;
    const page = rows.slice(0, limit).reverse();
    return { messages: await this.present(userId, groupId, channelId, page), nextCursor: more ? page[0]!.channelSequence : null, latestSequence: channel.lastSequence };
  }

  async context(userId: string, groupId: string, channelId: string, messageId: string) {
    const { channel } = await this.access.channel(userId, groupId, channelId);
    const target = await this.prisma.message.findFirst({ where: { id: messageId, conversationId: channel.conversationId, ...VISIBLE_MESSAGE }, include: MESSAGE_INCLUDE });
    if (!target) throw new NotFoundException('Message unavailable.');
    const [older, newer] = await Promise.all([
      this.prisma.message.findMany({ where: { conversationId: channel.conversationId, threadRootId: target.threadRootId, ...VISIBLE_MESSAGE, channelSequence: { lt: target.channelSequence! } }, include: MESSAGE_INCLUDE, orderBy: { channelSequence: 'desc' }, take: 20 }),
      this.prisma.message.findMany({ where: { conversationId: channel.conversationId, threadRootId: target.threadRootId, ...VISIBLE_MESSAGE, channelSequence: { gt: target.channelSequence! } }, include: MESSAGE_INCLUDE, orderBy: { channelSequence: 'asc' }, take: 20 }),
    ]);
    return { messages: await this.present(userId, groupId, channelId, [...older.reverse(), target, ...newer]), threadRootId: target.threadRootId, targetId: target.id };
  }

  private async requireRoot(conversationId: string, id: string, db: Prisma.TransactionClient = this.prisma) {
    const target = await db.message.findFirst({ where: { id, conversationId } });
    if (!target) throw new BadRequestException('Thread unavailable.');
    return target.threadRootId ?? target.id;
  }

  async send(userId: string, groupId: string, channelId: string, input: ChannelSendInput) {
    const body = input.body.trim();
    const attachments: ChannelAttachmentInput[] = input.attachments ?? (input.uploadId ? [{ uploadId: input.uploadId, thumbnailUploadId: input.thumbnailUploadId, alt: input.alt }] : []);
    if (attachments.length > CHANNEL_MAX_ATTACHMENTS || new Set(attachments.map(item => item.uploadId)).size !== attachments.length || (attachments.length && input.giphy)) throw new BadRequestException(`Attach up to ${CHANNEL_MAX_ATTACHMENTS} items.`);
    if ((!body && !attachments.length && !input.giphy) || body.length > 2000) throw new BadRequestException('Write a message of up to 2,000 characters.');
    const requestHash = createHash('sha256').update(JSON.stringify({ body, threadRootId: input.threadRootId ?? null, ...(input.replyToId ? { replyToId: input.replyToId } : {}), uploadId: input.uploadId ?? null, thumbnailUploadId: input.thumbnailUploadId ?? null, alt: input.alt ?? null, giphy: input.giphy ?? null, ...(input.attachments ? { attachments: input.attachments } : {}) })).digest('hex');
    let createdNow = false;
    const message = await this.prisma.$transaction(async tx => {
      await this.access.lockGroup(tx, groupId);
      const { channel, member } = await this.access.channel(userId, groupId, channelId, tx);
      const existing = await tx.message.findUnique({ where: { conversationId_senderId_clientRequestId: { conversationId: channel.conversationId, senderId: userId, clientRequestId: input.clientRequestId } }, include: MESSAGE_INCLUDE });
      if (existing) {
        if (existing.requestHash !== requestHash) throw new ConflictException('This request ID was already used for a different message.');
        return existing;
      }
      assertChannelSend(channel, member.role);
      const threadRootId = input.threadRootId ? await this.requireRoot(channel.conversationId, input.threadRootId, tx) : null;
      // Inline quoted reply: the target must be a live message in this same channel.
      const replyToId = input.replyToId
        ? (await tx.message.findFirst({ where: { id: input.replyToId, conversationId: channel.conversationId, deletedForAll: false, channelSequence: { not: null } }, select: { id: true } }))?.id ?? null
        : null;
      if (input.replyToId && !replyToId) throw new BadRequestException('That message is no longer available to reply to.');
      const uploaded = [];
      for (const item of attachments) uploaded.push({ ...(await this.media.consume(tx, userId, channelId, item.uploadId, item.thumbnailUploadId)), alt: item.alt ?? null });
      const media = uploaded.length ? uploaded : input.giphy ? [{ source: 'giphy' as const, kind: 'gif' as const, ...input.giphy, alt: input.alt ?? null }] : [];
      const updated = await tx.groupChannel.update({ where: { id: channelId }, data: { lastSequence: { increment: 1 }, revision: { increment: 1 } } });
      const created = await tx.message.create({ data: { conversationId: channel.conversationId, senderId: userId, body, clientRequestId: input.clientRequestId, requestHash, channelRevision: updated.revision, channelSequence: updated.lastSequence, threadRootId, replyToId, ...(media.length ? { media: { create: media } } : {}) }, include: MESSAGE_INCLUDE });
      if (threadRootId) await tx.message.update({ where: { id: threadRootId }, data: { channelRevision: updated.revision } });
      const rootMessageId = threadRootId ?? created.id;
      await tx.groupChannelThreadState.upsert({ where: { rootMessageId_userId: { rootMessageId, userId } }, create: { rootMessageId, userId, following: true }, update: {} });
      await tx.groupChannelThreadState.updateMany({ where: { rootMessageId, userId, unfollowed: false }, data: { following: true } });
      await this.attention.reconcile(tx, { groupId, channelId, messageId: created.id, senderId: userId, body, threadRootId, broadcast: isChannelLeader(member.role) });
      createdNow = true;
      return created;
    });
    await this.broadcast(groupId, channelId, message.id);
    const result = (await this.present(userId, groupId, channelId, [message]))[0];
    if (createdNow) this.effects.dispatch('channel.marv.request', { groupId, channelId, messageId: message.id, requesterId: userId }, { jobId: `channel-marv-${message.id}` });
    if (createdNow && Array.isArray(message.media) && message.media.some(item => item.kind === 'audio')) this.effects.dispatch('media.transcribe.request', { messageId: message.id }, { jobId: `transcribe-${message.id}` });
    if (createdNow) this.effects.dispatch('channel.message.changed', { groupId, channelId, messageId: message.id, edited: false }, { jobId: `channel-send-${message.id}` });
    return result;
  }

  /**
   * Records a new member in the group's #general as a `groupJoin` system row. Idempotent per join
   * time, so queue retries never duplicate it. It is silent: no push, badge, mention or unread dot.
   */
  async recordJoin(groupId: string, userId: string, at: string) {
    if (!this.access.enabled(groupId)) return;
    const clientRequestId = `join:${at}`;
    const created = await this.prisma.$transaction(async tx => {
      await this.access.lockGroup(tx, groupId);
      const channel = await tx.groupChannel.findUnique({ where: { groupId_defaultPurpose: { groupId, defaultPurpose: 'general' } } });
      if (!channel || channel.archivedAt) return null;
      const member = await tx.communityGroupMember.findUnique({ where: { groupId_userId: { groupId, userId } }, include: { user: { select: { bannedAt: true, isBot: true, verifiedStatus: true } } } });
      if (!member || member.status !== 'active' || member.user.bannedAt || member.user.isBot || member.user.verifiedStatus === 'none') return null;
      if (await tx.message.findFirst({ where: { conversationId: channel.conversationId, senderId: userId, kind: 'groupJoin', OR: [{ clientRequestId }, { createdAt: { gt: new Date(Date.now() - 60_000) } }] }, select: { id: true } })) return null;
      const updated = await tx.groupChannel.update({ where: { id: channel.id }, data: { lastSequence: { increment: 1 }, revision: { increment: 1 } } });
      const message = await tx.message.create({ data: { conversationId: channel.conversationId, senderId: userId, body: '', kind: 'groupJoin', clientRequestId, channelRevision: updated.revision, channelSequence: updated.lastSequence } });
      return { channelId: channel.id, messageId: message.id };
    });
    if (created) await this.broadcast(groupId, created.channelId, created.messageId);
  }

  /** Welcome button: posts "Welcome, <first name> 🤝" as the viewer (once per join row), then hides the button for them. */
  async welcome(userId: string, groupId: string, channelId: string, messageId: string) {
    const { channel } = await this.access.channel(userId, groupId, channelId);
    const join = await this.prisma.message.findFirst({ where: { id: messageId, conversationId: channel.conversationId, kind: 'groupJoin', deletedForAll: false }, include: { sender: { select: { name: true, username: true } } } });
    if (!join) throw new NotFoundException('Message unavailable.');
    if (join.senderId === userId) throw new BadRequestException('You cannot welcome yourself.');
    const first = join.sender.name?.trim().split(/\s+/)[0] || join.sender.username || 'friend';
    const message = await this.send(userId, groupId, channelId, { body: `Welcome, ${first} 🤝`, clientRequestId: `${WELCOME_PREFIX}${join.id}` });
    await this.prisma.$transaction(async tx => { await this.access.lockGroup(tx, groupId); await this.advanceRevision(tx, channelId, join.id); });
    await this.broadcast(groupId, channelId, join.id);
    return message;
  }

  private async advanceRevision(tx: Prisma.TransactionClient, channelId: string, messageId: string, rootId?: string | null) {
    const channel = await tx.groupChannel.update({ where: { id: channelId }, data: { revision: { increment: 1 } } });
    await tx.message.updateMany({ where: { id: { in: rootId ? [messageId, rootId] : [messageId] } }, data: { channelRevision: channel.revision } });
  }

  /** Publish a server-side change to message media (for example a finished transcript) as a new revision. */
  async publishMediaChange(groupId: string, channelId: string, messageId: string) {
    const message = await this.prisma.message.findUnique({ where: { id: messageId }, select: { threadRootId: true } });
    await this.prisma.$transaction(async tx => { await this.access.lockGroup(tx, groupId); await this.advanceRevision(tx, channelId, messageId, message?.threadRootId); });
    await this.broadcast(groupId, channelId, messageId);
  }

  async edit(userId: string, groupId: string, channelId: string, messageId: string, body: string) {
    await this.prisma.$transaction(async tx => {
      await this.access.lockGroup(tx, groupId);
      const { channel, member } = await this.access.channel(userId, groupId, channelId, tx);
      assertChannelSend(channel, member.role);
      const message = await tx.message.findFirst({ where: { id: messageId, conversationId: channel.conversationId, senderId: userId, deletedForAll: false, kind: 'text' } });
      if (!message || Date.now() - message.createdAt.getTime() >= 15 * 60_000) throw new ForbiddenException('This message can no longer be edited.');
      await this.advanceRevision(tx, channelId, messageId);
      const hiddenPreviews = message.hiddenPreviews.filter(url => body.includes(url));
      await tx.message.update({ where: { id: messageId }, data: { body, hiddenPreviews, editedAt: new Date() } });
      await this.attention.reconcile(tx, { groupId, channelId, messageId, senderId: userId, body, threadRootId: message.threadRootId, edited: true, broadcast: isChannelLeader(member.role) });
    });
    await this.broadcast(groupId, channelId, messageId);
    this.effects.dispatch('channel.message.changed', { groupId, channelId, messageId, edited: true });
  }

  /** The author removes (or restores) the rich preview of one link in their own message. */
  async hidePreview(userId: string, groupId: string, channelId: string, messageId: string, url: string, hidden: boolean) {
    await this.prisma.$transaction(async tx => {
      await this.access.lockGroup(tx, groupId);
      const { channel, member } = await this.access.channel(userId, groupId, channelId, tx);
      assertChannelSend(channel, member.role);
      const message = await tx.message.findFirst({ where: { id: messageId, conversationId: channel.conversationId, senderId: userId, deletedForAll: false, kind: 'text' } });
      if (!message) throw new ForbiddenException('Only the author can remove previews.');
      if (!message.body.includes(url)) throw new BadRequestException('That link is not in this message.');
      const rest = message.hiddenPreviews.filter(item => item !== url);
      const next = hidden ? [...rest, url].slice(-MAX_HIDDEN_PREVIEWS) : rest;
      if (next.length === message.hiddenPreviews.length && next.every(item => message.hiddenPreviews.includes(item))) return;
      await this.advanceRevision(tx, channelId, messageId, message.threadRootId);
      await tx.message.update({ where: { id: messageId }, data: { hiddenPreviews: next } });
    });
    await this.broadcast(groupId, channelId, messageId);
  }

  async delete(userId: string, groupId: string, channelId: string, messageId: string) {
    await this.prisma.$transaction(async tx => {
      await this.access.lockGroup(tx, groupId);
      const { channel, member } = await this.access.channel(userId, groupId, channelId, tx);
      if (channel.archivedAt) throw new ForbiddenException('This channel is archived.');
      const message = await tx.message.findFirst({ where: { id: messageId, conversationId: channel.conversationId } });
      if (!message || (message.senderId !== userId && !isChannelLeader(member.role))) throw new ForbiddenException('You cannot delete this message.');
      await this.advanceRevision(tx, channelId, messageId, message.threadRootId);
      await tx.message.update({ where: { id: messageId }, data: { deletedForAll: true, deletedForAllAt: new Date(), body: '' } });
      await tx.groupChannelPin.deleteMany({ where: { messageId } });
      await tx.groupChannelAttention.deleteMany({ where: { messageId } });
      await tx.marvinMemorySource.deleteMany({ where: { messageId } });
    });
    await this.broadcast(groupId, channelId, messageId);
    this.effects.dispatch('channel.message.changed', { groupId, channelId, messageId, edited: true });
  }

  async reaction(userId: string, groupId: string, channelId: string, messageId: string, reactionId: string, add: boolean) {
    const reaction = findReactionById(reactionId);
    if (!reaction) throw new BadRequestException('Unknown reaction.');
    await this.prisma.$transaction(async tx => {
      await this.access.lockGroup(tx, groupId);
      const { channel } = await this.access.channel(userId, groupId, channelId, tx);
      if (channel.archivedAt) throw new ForbiddenException('This channel is archived.');
      const message = await tx.message.findFirst({ where: { id: messageId, conversationId: channel.conversationId, deletedForAll: false } });
      if (!message) throw new NotFoundException('Message unavailable.');
      await this.advanceRevision(tx, channelId, messageId);
      if (add) await tx.messageReaction.upsert({ where: { messageId_userId_reactionId: { messageId, userId, reactionId } }, create: { messageId, userId, reactionId, emoji: reaction.emoji }, update: {} });
      else await tx.messageReaction.deleteMany({ where: { messageId, userId, reactionId } });
    });
    await this.broadcast(groupId, channelId, messageId);
  }

  async pin(userId: string, groupId: string, channelId: string, messageId: string, pinned: boolean) {
    await this.prisma.$transaction(async tx => {
      await this.access.lockGroup(tx, groupId);
      const { channel, member } = await this.access.channel(userId, groupId, channelId, tx);
      if (channel.archivedAt || !isChannelLeader(member.role)) throw new ForbiddenException('Only leaders can change pins in an active channel.');
      const message = await tx.message.findFirst({ where: { id: messageId, conversationId: channel.conversationId, deletedForAll: false } });
      if (!message) throw new NotFoundException('Message unavailable.');
      await this.advanceRevision(tx, channelId, messageId);
      if (pinned) await tx.groupChannelPin.upsert({ where: { channelId_messageId: { channelId, messageId } }, create: { channelId, messageId, pinnedByUserId: userId }, update: {} });
      else await tx.groupChannelPin.deleteMany({ where: { channelId, messageId } });
    });
    await this.broadcast(groupId, channelId, messageId);
  }

  async pins(userId: string, groupId: string, channelId: string) {
    const { channel } = await this.access.channel(userId, groupId, channelId);
    const rows = await this.prisma.message.findMany({ where: { conversationId: channel.conversationId, deletedForAll: false, channelPins: { some: { channelId } } }, include: MESSAGE_INCLUDE, orderBy: { channelSequence: 'desc' }, take: 100 });
    return this.present(userId, groupId, channelId, rows);
  }

  async search(userId: string, groupId: string, input: { q: string; channelId?: string; before?: string }) {
    await this.access.member(userId, groupId);
    const readable = await this.prisma.groupChannel.findMany({ where: { ...this.access.readableWhere(userId, groupId), ...(input.channelId ? { id: input.channelId } : {}) }, select: { id: true, conversationId: true } });
    if (input.channelId && !readable.length) throw new NotFoundException('Channel unavailable.');
    const channelByConversation = new Map(readable.map(channel => [channel.conversationId, channel.id]));
    const rows = await this.prisma.message.findMany({
      where: { conversationId: { in: [...channelByConversation.keys()] }, deletedForAll: false, body: { contains: input.q, mode: 'insensitive' } },
      include: MESSAGE_INCLUDE, orderBy: [{ createdAt: 'desc' }, { id: 'desc' }], take: 41,
      ...(input.before ? { cursor: { id: input.before }, skip: 1 } : {}),
    });
    const page = rows.slice(0, 40);
    const byChannel = new Map<string, MessageRow[]>();
    for (const row of page) {
      const channelId = channelByConversation.get(row.conversationId)!;
      byChannel.set(channelId, [...(byChannel.get(channelId) ?? []), row]);
    }
    const presented = new Map<string, GroupChannelMessageDto>();
    for (const [channelId, channelRows] of byChannel) for (const dto of await this.present(userId, groupId, channelId, channelRows)) presented.set(dto.id, dto);
    return { messages: page.map(row => presented.get(row.id)!), nextCursor: rows.length > 40 ? page.at(-1)!.id : null };
  }

  async personal(userId: string, groupId: string) {
    await this.access.member(userId, groupId);
    const rows = await this.prisma.groupChannelAttention.findMany({ where: { userId, readAt: null, channel: this.access.readableWhere(userId, groupId), message: personalChannelMessageWhere(userId) }, include: { message: { include: MESSAGE_INCLUDE } }, orderBy: { createdAt: 'desc' }, take: 100 });
    const byChannel = new Map<string, MessageRow[]>();
    for (const row of rows) byChannel.set(row.channelId, [...(byChannel.get(row.channelId) ?? []), row.message]);
    const messages = new Map<string, GroupChannelMessageDto>();
    for (const [channelId, channelRows] of byChannel) for (const dto of await this.present(userId, groupId, channelId, channelRows)) messages.set(dto.id, dto);
    return rows.map(row => ({ channelId: row.channelId, messageId: row.messageId, threadRootId: row.message.threadRootId, mentioned: row.mentioned, followedReply: row.followedReply, createdAt: row.createdAt.toISOString(), message: messages.get(row.messageId)! }));
  }
}
