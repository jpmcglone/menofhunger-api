import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import type { GroupChannelMessageDto, GroupChannelReceiptDto } from '../../common/dto/group-channel.dto';
import { toMessageDto, transcriptFields } from '../messages/message.dto';
import { PresenceRealtimeService } from '../presence/presence-realtime.service';
import { AppConfigService } from '../app/app-config.service';
import { PrismaService } from '../prisma/prisma.service';
import { ChannelAccessService } from './channel-access.service';
import { ChannelsService } from './channels.service';
import { channelCapabilities, isChannelLeader } from './channel-policy';
import { personalChannelMessageWhere } from './channel-attention-policy';
import { toPage } from '../../common/pagination/page';
import { MESSAGE_INCLUDE, VISIBLE_MESSAGE, WELCOME_PREFIX, type MessageRow } from './channel-message-rows';

/** Reads, realtime fan-out, and search over channel messages (writes live in ChannelMessagesService). */
@Injectable()
export class ChannelMessageReadService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly access: ChannelAccessService,
    private readonly channels: ChannelsService,
    private readonly config: AppConfigService,
    private readonly realtime: PresenceRealtimeService,
  ) {}

  async present(userId: string, groupId: string, channelId: string, rows: MessageRow[]): Promise<GroupChannelMessageDto[]> {
    // Recheck after the query as well: a slow read must not return content after revocation.
    const { channel, member } = await this.access.channel(userId, groupId, channelId);
    const roots = rows.map((m) => m.threadRootId ?? m.id);
    const states = await this.prisma.groupChannelThreadState.findMany({
      where: { userId, rootMessageId: { in: roots } },
    });
    const follows = new Set(states.filter((s) => s.following).map((s) => s.rootMessageId));
    const receipts = await this.receipts(userId, groupId, channel, rows);
    const welcomes = await this.welcomes(rows);
    return this.render(userId, member.role, groupId, channel, rows, follows, receipts, welcomes.get(userId));
  }

  private render(
    userId: string,
    role: Parameters<typeof channelCapabilities>[1],
    groupId: string,
    channel: Parameters<typeof channelCapabilities>[0] & { id: string },
    rows: MessageRow[],
    follows: Set<string>,
    receipts: Map<string, GroupChannelReceiptDto>,
    welcomed: Set<string> = new Set(),
  ): GroupChannelMessageDto[] {
    const channelId = channel.id;
    const member = { role };
    return rows.map((message) => ({
      receipt: receipts.get(message.id) ?? null,
      ...toMessageDto({
        message: { ...message, media: [] },
        publicBaseUrl: this.config.r2()?.publicBaseUrl ?? null,
        viewerUserId: userId,
      }),
      // Uploaded channel media is never mapped through the public Chat URL resolver.
      media: message.deletedForAll
        ? []
        : message.media.map((media) => ({
            id: media.id,
            kind: media.kind,
            source: media.source,
            url: media.source === 'upload' ? `/groups/${groupId}/channels/${channelId}/media/${media.id}` : (media.url ?? ''),
            thumbnailUrl: media.thumbnailR2Key ? `/groups/${groupId}/channels/${channelId}/media/${media.id}?thumbnail=true` : null,
            mp4Url: media.source === 'upload' ? null : media.mp4Url,
            width: media.width,
            height: media.height,
            durationSeconds: media.durationSeconds === null ? null : Math.floor(media.durationSeconds),
            alt: media.alt,
            ...transcriptFields(media),
          })),
      clientRequestId: message.senderId === userId ? message.clientRequestId : null,
      revision: message.channelRevision,
      channelId,
      sequence: message.channelSequence!,
      threadRootId: message.threadRootId,
      hiddenPreviews: message.deletedForAll ? [] : message.hiddenPreviews,
      replyCount: message._count.threadReplies,
      lastReplyAt: message.threadReplies[0]?.createdAt.toISOString() ?? null,
      following: follows.has(message.threadRootId ?? message.id),
      pinned: message.channelPins.length > 0 && !message.deletedForAll,
      joinWelcome:
        message.kind === 'groupJoin' && !message.deletedForAll
          ? {
              canWelcome: message.senderId !== userId && !welcomed.has(message.id) && !channel.archivedAt && channelCapabilities(channel, member.role).canSend,
            }
          : null,
      canEdit:
        message.kind === 'text' &&
        channelCapabilities(channel, member.role).canSend &&
        !message.deletedForAll &&
        message.senderId === userId &&
        Date.now() - message.createdAt.getTime() < 15 * 60_000,
      canDelete: !channel.archivedAt && !message.deletedForAll && (message.senderId === userId || isChannelLeader(member.role)),
    }));
  }

  /** Who already welcomed each join row: member ID -> join message IDs. A welcome is the member's own `welcome:<joinId>` message. */
  private async welcomes(rows: MessageRow[]) {
    const byUser = new Map<string, Set<string>>();
    const joins = rows.filter((message) => message.kind === 'groupJoin' && !message.deletedForAll);
    if (!joins.length) return byUser;
    const sent = await this.prisma.message.findMany({
      where: {
        conversationId: { in: [...new Set(joins.map((message) => message.conversationId))] },
        deletedForAll: false,
        clientRequestId: { in: joins.map((message) => `${WELCOME_PREFIX}${message.id}`) },
      },
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
    const own = rows.filter((message) => message.senderId === userId && !message.deletedForAll && message.channelSequence);
    const result = new Map<string, GroupChannelReceiptDto>();
    if (!own.length) return result;
    const eligible = Prisma.sql`
      JOIN "CommunityGroupMember" gm ON gm."groupId" = ${groupId} AND gm."userId" = r."userId" AND gm.status = 'active'
      JOIN "User" u ON u.id = r."userId" AND u."bannedAt" IS NULL AND NOT u."isBot" AND u."verifiedStatus" <> 'none'
      ${channel.privacy === 'private' ? Prisma.sql`JOIN "GroupChannelAccess" a ON a."channelId" = ${channel.id} AND a."userId" = r."userId"` : Prisma.empty}`;
    const top = own.filter((message) => !message.threadRootId).map((message) => message.id);
    const replies = own.filter((message) => message.threadRootId).map((message) => message.id);
    const [recipients, topCounts, replyCounts] = await Promise.all([
      known ?? this.access.recipients(groupId, channel.id),
      top.length
        ? this.prisma.$queryRaw<Array<{ id: string; reads: number }>>(Prisma.sql`
        SELECT m.id, COUNT(*)::int AS reads FROM "Message" m
        JOIN "GroupChannelViewerState" r ON r."channelId" = ${channel.id} AND r."userId" <> m."senderId" AND r."readThrough" >= m."channelSequence"
        ${eligible}
        WHERE m.id IN (${Prisma.join(top)}) GROUP BY m.id`)
        : [],
      replies.length
        ? this.prisma.$queryRaw<Array<{ id: string; reads: number }>>(Prisma.sql`
        SELECT m.id, COUNT(*)::int AS reads FROM "Message" m
        JOIN "GroupChannelThreadState" r ON r."rootMessageId" = m."threadRootId" AND r."userId" <> m."senderId" AND r."readThrough" >= m."channelSequence"
        ${eligible}
        WHERE m.id IN (${Prisma.join(replies)}) GROUP BY m.id`)
        : [],
    ]);
    const reads = new Map([...topCounts, ...replyCounts].map((row) => [row.id, row.reads]));
    const recipientCount = Math.max(recipients.filter((member) => member.userId !== userId).length, 0);
    for (const message of own) result.set(message.id, { readCount: Math.min(reads.get(message.id) ?? 0, recipientCount), recipientCount });
    return result;
  }

  /** Tells each sender that someone newly read their messages by re-sending their canonical snapshots. */
  async broadcastReceipts(groupId: string, channelId: string, readerId: string, range: { from: number; through: number; threadRootId?: string }) {
    if (range.through <= range.from) return;
    const channel = await this.prisma.groupChannel.findUnique({ where: { id: channelId } });
    if (!channel) return;
    const rows = await this.prisma.message.findMany({
      where: {
        conversationId: channel.conversationId,
        deletedForAll: false,
        senderId: { not: readerId },
        threadRootId: range.threadRootId ?? null,
        channelSequence: { gt: range.from, lte: range.through },
      },
      include: MESSAGE_INCLUDE,
      orderBy: { channelSequence: 'asc' },
      take: 100,
    });
    const bySender = new Map<string, MessageRow[]>();
    for (const row of rows) bySender.set(row.senderId, [...(bySender.get(row.senderId) ?? []), row]);
    for (const [senderId, own] of bySender) {
      try {
        const snapshot = await this.channels.details(senderId, groupId, channelId);
        this.realtime.emitGroupChannelMessages(senderId, {
          groupId,
          channel: snapshot,
          messages: await this.present(senderId, groupId, channelId, own),
        });
      } catch (error) {
        if (!(error instanceof NotFoundException)) throw error;
      }
    }
  }

  async broadcast(groupId: string, channelId: string, messageId: string) {
    const channel = await this.prisma.groupChannel.findUniqueOrThrow({ where: { id: channelId } });
    const message = await this.prisma.message.findFirst({
      where: { id: messageId, conversationId: channel.conversationId },
      include: MESSAGE_INCLUDE,
    });
    if (!message) return;
    const root = message.threadRootId ? await this.prisma.message.findUnique({ where: { id: message.threadRootId }, include: MESSAGE_INCLUDE }) : null;
    const rows = root ? [root, message] : [message];
    const recipients = await this.access.recipients(groupId, channelId);
    const [snapshots, states] = await Promise.all([
      this.channels.viewerSnapshots(channelId, recipients),
      this.prisma.groupChannelThreadState.findMany({
        where: {
          userId: { in: recipients.map((r) => r.userId) },
          rootMessageId: { in: rows.map((m) => m.threadRootId ?? m.id) },
          following: true,
        },
        select: { userId: true, rootMessageId: true },
      }),
    ]);
    const followsByUser = new Map<string, Set<string>>();
    for (const state of states) followsByUser.set(state.userId, (followsByUser.get(state.userId) ?? new Set()).add(state.rootMessageId));
    const welcomes = await this.welcomes(rows);
    const owners = new Set(rows.map((m) => m.senderId));
    const receiptsByOwner = new Map<string, Map<string, GroupChannelReceiptDto>>();
    for (const owner of owners)
      if (recipients.some((r) => r.userId === owner)) receiptsByOwner.set(owner, await this.receipts(owner, groupId, channel, rows, recipients));
    for (const recipient of recipients) {
      const snapshot = snapshots.get(recipient.userId);
      if (!snapshot) continue;
      const messages = this.render(
        recipient.userId,
        recipient.role,
        groupId,
        channel,
        rows,
        followsByUser.get(recipient.userId) ?? new Set(),
        receiptsByOwner.get(recipient.userId) ?? new Map(),
        welcomes.get(recipient.userId),
      );
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
        where: {
          conversationId: channel.conversationId,
          threadRootId: root,
          channelRevision: { gt: input.changedSince },
        },
        include: MESSAGE_INCLUDE,
        orderBy: [{ channelRevision: 'asc' }, { id: 'asc' }],
        take: limit + 1,
      });
      const { items: page, nextCursor } = toPage(rows, limit, (m) => m.channelRevision);
      return {
        messages: await this.present(userId, groupId, channelId, page),
        nextCursor,
        latestSequence: channel.lastSequence,
      };
    }
    const rows = await this.prisma.message.findMany({
      where: {
        conversationId: channel.conversationId,
        threadRootId: root,
        ...VISIBLE_MESSAGE,
        ...(input.before ? { channelSequence: { lt: input.before } } : {}),
      },
      include: MESSAGE_INCLUDE,
      orderBy: { channelSequence: 'desc' },
      take: limit + 1,
    });
    const { items, nextCursor } = toPage(rows, limit, (m) => m.channelSequence);
    const page = [...items].reverse();
    return {
      messages: await this.present(userId, groupId, channelId, page),
      nextCursor,
      latestSequence: channel.lastSequence,
    };
  }

  async context(userId: string, groupId: string, channelId: string, messageId: string) {
    const { channel } = await this.access.channel(userId, groupId, channelId);
    const target = await this.prisma.message.findFirst({
      where: { id: messageId, conversationId: channel.conversationId, ...VISIBLE_MESSAGE },
      include: MESSAGE_INCLUDE,
    });
    if (!target) throw new NotFoundException('Message unavailable.');
    const [older, newer] = await Promise.all([
      this.prisma.message.findMany({
        where: {
          conversationId: channel.conversationId,
          threadRootId: target.threadRootId,
          ...VISIBLE_MESSAGE,
          channelSequence: { lt: target.channelSequence! },
        },
        include: MESSAGE_INCLUDE,
        orderBy: { channelSequence: 'desc' },
        take: 20,
      }),
      this.prisma.message.findMany({
        where: {
          conversationId: channel.conversationId,
          threadRootId: target.threadRootId,
          ...VISIBLE_MESSAGE,
          channelSequence: { gt: target.channelSequence! },
        },
        include: MESSAGE_INCLUDE,
        orderBy: { channelSequence: 'asc' },
        take: 20,
      }),
    ]);
    return {
      messages: await this.present(userId, groupId, channelId, [...older.reverse(), target, ...newer]),
      threadRootId: target.threadRootId,
      targetId: target.id,
    };
  }

  async requireRoot(conversationId: string, id: string, db: Prisma.TransactionClient = this.prisma) {
    const target = await db.message.findFirst({ where: { id, conversationId } });
    if (!target) throw new BadRequestException('Thread unavailable.');
    return target.threadRootId ?? target.id;
  }

  async pins(userId: string, groupId: string, channelId: string) {
    const { channel } = await this.access.channel(userId, groupId, channelId);
    const rows = await this.prisma.message.findMany({
      where: { conversationId: channel.conversationId, deletedForAll: false, channelPins: { some: { channelId } } },
      include: MESSAGE_INCLUDE,
      orderBy: { channelSequence: 'desc' },
      take: 100,
    });
    return this.present(userId, groupId, channelId, rows);
  }

  async search(userId: string, groupId: string, input: { q: string; channelId?: string; before?: string }) {
    await this.access.member(userId, groupId);
    const readable = await this.prisma.groupChannel.findMany({
      where: { ...this.access.readableWhere(userId, groupId), ...(input.channelId ? { id: input.channelId } : {}) },
      select: { id: true, conversationId: true },
    });
    if (input.channelId && !readable.length) throw new NotFoundException('Channel unavailable.');
    const channelByConversation = new Map(readable.map((channel) => [channel.conversationId, channel.id]));
    const rows = await this.prisma.message.findMany({
      where: {
        conversationId: { in: [...channelByConversation.keys()] },
        deletedForAll: false,
        body: { contains: input.q, mode: 'insensitive' },
      },
      include: MESSAGE_INCLUDE,
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      take: 41,
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
    return {
      messages: page.map((row) => presented.get(row.id)!),
      nextCursor: rows.length > 40 ? page.at(-1)!.id : null,
    };
  }

  async personal(userId: string, groupId: string) {
    await this.access.member(userId, groupId);
    const rows = await this.prisma.groupChannelAttention.findMany({
      where: {
        userId,
        readAt: null,
        channel: this.access.readableWhere(userId, groupId),
        message: personalChannelMessageWhere(userId),
      },
      include: { message: { include: MESSAGE_INCLUDE } },
      orderBy: { createdAt: 'desc' },
      take: 100,
    });
    const byChannel = new Map<string, MessageRow[]>();
    for (const row of rows) byChannel.set(row.channelId, [...(byChannel.get(row.channelId) ?? []), row.message]);
    const messages = new Map<string, GroupChannelMessageDto>();
    for (const [channelId, channelRows] of byChannel) for (const dto of await this.present(userId, groupId, channelId, channelRows)) messages.set(dto.id, dto);
    return rows.map((row) => ({
      channelId: row.channelId,
      messageId: row.messageId,
      threadRootId: row.message.threadRootId,
      mentioned: row.mentioned,
      followedReply: row.followedReply,
      createdAt: row.createdAt.toISOString(),
      message: messages.get(row.messageId)!,
    }));
  }
}
