import { BadRequestException, ForbiddenException, Inject, Injectable, NotFoundException, forwardRef } from '@nestjs/common';
import type { MessageConversation } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { AppConfigService } from '../app/app-config.service';
import { PresenceGateway } from '../presence/presence.gateway';
import { NotificationsService } from '../notifications/notifications.service';
import { createdAtIdCursorWhere } from '../../common/pagination/created-at-id-cursor';
import { toUserListDto } from '../../common/dto';
import { toMessageDto, toMessageParticipantDto, type MessageConversationDto, type MessageDto } from './message.dto';

const CONVERSATION_LIST_LIMIT = 30;
const MESSAGE_LIST_LIMIT = 50;
const MESSAGE_BODY_MAX = 2000;

type ConversationCursor = { updatedAt: string; id: string };

@Injectable()
export class MessagesService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly appConfig: AppConfigService,
    private readonly presenceGateway: PresenceGateway,
    @Inject(forwardRef(() => NotificationsService))
    private readonly notificationsService: NotificationsService,
  ) {}

  private encodeConversationCursor(cursor: ConversationCursor): string {
    return Buffer.from(JSON.stringify(cursor), 'utf8').toString('base64url');
  }

  private decodeConversationCursor(token: string | null): ConversationCursor | null {
    const t = (token ?? '').trim();
    if (!t) return null;
    try {
      const raw = Buffer.from(t, 'base64url').toString('utf8');
      const parsed = JSON.parse(raw) as Partial<ConversationCursor>;
      if (!parsed?.updatedAt || !parsed?.id) return null;
      return { updatedAt: String(parsed.updatedAt), id: String(parsed.id) };
    } catch {
      return null;
    }
  }

  private directKeyFor(a: string, b: string): string {
    return [a, b].sort().join(':');
  }

  private async getBlockedUserIds(userId: string): Promise<Set<string>> {
    const rows = await this.prisma.userBlock.findMany({
      where: {
        OR: [{ blockerId: userId }, { blockedId: userId }],
      },
      select: { blockerId: true, blockedId: true },
    });
    const blocked = new Set<string>();
    for (const row of rows) {
      blocked.add(row.blockerId === userId ? row.blockedId : row.blockerId);
    }
    return blocked;
  }

  private async assertNotBlocked(userId: string, otherUserIds: string[]): Promise<void> {
    if (otherUserIds.length === 0) return;
    const blocked = await this.getBlockedUserIds(userId);
    for (const otherId of otherUserIds) {
      if (blocked.has(otherId)) {
        throw new ForbiddenException('You cannot message this user.');
      }
    }
  }

  private async getConversationOrThrow(params: { userId: string; conversationId: string }) {
    const { userId, conversationId } = params;
    const blockedUserIds = await this.getBlockedUserIds(userId);
    const conversation = await this.prisma.messageConversation.findFirst({
      where: {
        id: conversationId,
        participants: { some: { userId } },
        ...(blockedUserIds.size > 0
          ? { participants: { none: { userId: { in: [...blockedUserIds] } } } }
          : {}),
      },
      include: {
        participants: {
          include: {
            user: {
              select: {
                id: true,
                username: true,
                name: true,
                premium: true,
                premiumPlus: true,
                verifiedStatus: true,
                avatarKey: true,
                avatarUpdatedAt: true,
              },
            },
          },
        },
        lastMessage: {
          select: { id: true, body: true, createdAt: true, senderId: true },
        },
      },
    });
    if (!conversation) throw new NotFoundException('Conversation not found.');
    return conversation;
  }

  private async getUnreadCount(params: { userId: string; conversationId: string; lastReadAt: Date | null }): Promise<number> {
    const { userId, conversationId, lastReadAt } = params;
    return await this.prisma.message.count({
      where: {
        conversationId,
        senderId: { not: userId },
        ...(lastReadAt ? { createdAt: { gt: lastReadAt } } : {}),
      },
    });
  }

  private async getUnreadCounts(userId: string): Promise<{ primary: number; requests: number }> {
    const blockedUserIds = await this.getBlockedUserIds(userId);
    const participants = await this.prisma.messageParticipant.findMany({
      where: {
        userId,
        ...(blockedUserIds.size > 0
          ? { conversation: { participants: { none: { userId: { in: [...blockedUserIds] } } } } }
          : {}),
      },
      select: { conversationId: true, status: true, lastReadAt: true },
    });
    const counts = await Promise.all(
      participants.map(async (p) => ({
        status: p.status,
        count: await this.getUnreadCount({
          userId,
          conversationId: p.conversationId,
          lastReadAt: p.lastReadAt,
        }),
      })),
    );
    let primary = 0;
    let requests = 0;
    for (const row of counts) {
      if (row.status === 'accepted') primary += row.count;
      else requests += row.count;
    }
    return { primary, requests };
  }

  private emitUnreadCounts(userId: string): void {
    void this.getUnreadCounts(userId).then((counts) => {
      this.presenceGateway.emitMessagesUpdated(userId, {
        primaryUnreadCount: counts.primary,
        requestUnreadCount: counts.requests,
      });
    });
  }

  /**
   * Resolve all participant user IDs for a conversation, asserting the viewer is a participant.
   * Used by realtime features (e.g. typing indicators) to broadcast to conversation members.
   */
  async listConversationParticipantUserIds(params: { userId: string; conversationId: string }): Promise<string[]> {
    const { userId, conversationId } = params;
    const conversation = await this.getConversationOrThrow({ userId, conversationId });
    return conversation.participants.map((p) => p.userId);
  }

  async listConversations(params: {
    userId: string;
    tab: 'primary' | 'requests';
    limit?: number;
    cursor?: string | null;
  }) {
    const { userId, tab } = params;
    const limit = params.limit ?? CONVERSATION_LIST_LIMIT;
    const cursor = this.decodeConversationCursor(params.cursor ?? null);
    const blockedUserIds = await this.getBlockedUserIds(userId);

    const cursorWhere =
      cursor?.updatedAt && cursor?.id
        ? {
            OR: [
              { updatedAt: { lt: new Date(cursor.updatedAt) } },
              { AND: [{ updatedAt: new Date(cursor.updatedAt) }, { id: { lt: cursor.id } }] },
            ],
          }
        : null;

    const conversations = await this.prisma.messageConversation.findMany({
      where: {
        ...(cursorWhere ? { AND: [cursorWhere] } : {}),
        participants: {
          some: {
            userId,
            status: tab === 'primary' ? 'accepted' : 'pending',
          },
        },
        ...(blockedUserIds.size > 0
          ? { participants: { none: { userId: { in: [...blockedUserIds] } } } }
          : {}),
      },
      include: {
        participants: {
          include: {
            user: {
              select: {
                id: true,
                username: true,
                name: true,
                premium: true,
                premiumPlus: true,
                verifiedStatus: true,
                avatarKey: true,
                avatarUpdatedAt: true,
              },
            },
          },
        },
        lastMessage: {
          select: { id: true, body: true, createdAt: true, senderId: true },
        },
      },
      orderBy: [{ updatedAt: 'desc' }, { id: 'desc' }],
      take: limit + 1,
    });

    const slice = conversations.slice(0, limit);
    const nextCursor =
      conversations.length > limit
        ? this.encodeConversationCursor({
            updatedAt: slice[slice.length - 1]?.updatedAt.toISOString(),
            id: slice[slice.length - 1]?.id ?? '',
          })
        : null;

    const publicBaseUrl = this.appConfig.r2()?.publicBaseUrl ?? null;
    const items: MessageConversationDto[] = await Promise.all(
      slice.map(async (conversation) => {
        const viewerParticipant = conversation.participants.find((p) => p.userId === userId);
        if (!viewerParticipant) throw new NotFoundException('Conversation not found.');
        const unreadCount = await this.getUnreadCount({
          userId,
          conversationId: conversation.id,
          lastReadAt: viewerParticipant.lastReadAt,
        });

        return {
          id: conversation.id,
          type: conversation.type,
          title: conversation.title ?? null,
          createdAt: conversation.createdAt.toISOString(),
          updatedAt: conversation.updatedAt.toISOString(),
          lastMessageAt: conversation.lastMessageAt ? conversation.lastMessageAt.toISOString() : null,
          lastMessage: conversation.lastMessage
            ? {
                id: conversation.lastMessage.id,
                body: conversation.lastMessage.body,
                createdAt: conversation.lastMessage.createdAt.toISOString(),
                senderId: conversation.lastMessage.senderId,
              }
            : null,
          participants: conversation.participants.map((p) =>
            toMessageParticipantDto({
              user: p.user,
              status: p.status,
              role: p.role,
              acceptedAt: p.acceptedAt,
              lastReadAt: p.lastReadAt,
              publicBaseUrl,
            }),
          ),
          viewerStatus: viewerParticipant.status,
          unreadCount,
        };
      }),
    );

    return { conversations: items, nextCursor };
  }

  async lookupConversation(params: { userId: string; recipientUserIds: string[] }) {
    const { userId, recipientUserIds } = params;
    const uniqueRecipients = [...new Set(recipientUserIds.filter(Boolean))].filter((id) => id !== userId);
    if (uniqueRecipients.length === 0) return { conversationId: null };
    await this.assertNotBlocked(userId, uniqueRecipients);

    if (uniqueRecipients.length === 1) {
      const directKey = this.directKeyFor(userId, uniqueRecipients[0]);
      const existing = await this.prisma.messageConversation.findFirst({
        where: { type: 'direct', directKey },
        select: { id: true },
      });
      return { conversationId: existing?.id ?? null };
    }

    const memberSet = new Set<string>([userId, ...uniqueRecipients]);
    const candidates = await this.prisma.messageConversation.findMany({
      where: {
        type: 'group',
        participants: {
          some: { userId },
          every: { userId: { in: [...memberSet] } },
        },
      },
      select: {
        id: true,
        participants: { select: { userId: true } },
      },
    });

    for (const convo of candidates) {
      const ids = new Set(convo.participants.map((p) => p.userId));
      if (ids.size !== memberSet.size) continue;
      let match = true;
      for (const id of memberSet) {
        if (!ids.has(id)) {
          match = false;
          break;
        }
      }
      if (match) return { conversationId: convo.id };
    }

    return { conversationId: null };
  }

  async getConversation(params: { userId: string; conversationId: string }) {
    const { userId, conversationId } = params;
    const conversation = await this.getConversationOrThrow({ userId, conversationId });
    const viewerParticipant = conversation.participants.find((p) => p.userId === userId);
    if (!viewerParticipant) throw new NotFoundException('Conversation not found.');

    const publicBaseUrl = this.appConfig.r2()?.publicBaseUrl ?? null;
    const unreadCount = await this.getUnreadCount({
      userId,
      conversationId,
      lastReadAt: viewerParticipant.lastReadAt,
    });
    const dto: MessageConversationDto = {
      id: conversation.id,
      type: conversation.type,
      title: conversation.title ?? null,
      createdAt: conversation.createdAt.toISOString(),
      updatedAt: conversation.updatedAt.toISOString(),
      lastMessageAt: conversation.lastMessageAt ? conversation.lastMessageAt.toISOString() : null,
      lastMessage: conversation.lastMessage
        ? {
            id: conversation.lastMessage.id,
            body: conversation.lastMessage.body,
            createdAt: conversation.lastMessage.createdAt.toISOString(),
            senderId: conversation.lastMessage.senderId,
          }
        : null,
      participants: conversation.participants.map((p) =>
        toMessageParticipantDto({
          user: p.user,
          status: p.status,
          role: p.role,
          acceptedAt: p.acceptedAt,
          lastReadAt: p.lastReadAt,
          publicBaseUrl,
        }),
      ),
      viewerStatus: viewerParticipant.status,
      unreadCount,
    };

    const messages = await this.listMessages({ userId, conversationId, limit: MESSAGE_LIST_LIMIT });
    return { conversation: dto, messages: messages.messages, nextCursor: messages.nextCursor };
  }

  async listMessages(params: {
    userId: string;
    conversationId: string;
    limit?: number;
    cursor?: string | null;
  }): Promise<{ messages: MessageDto[]; nextCursor: string | null }> {
    const { userId, conversationId } = params;
    const limit = params.limit ?? MESSAGE_LIST_LIMIT;
    await this.getConversationOrThrow({ userId, conversationId });

    const cursorWhere = await createdAtIdCursorWhere({
      cursor: params.cursor ?? null,
      lookup: async (id) =>
        this.prisma.message.findUnique({
          where: { id },
          select: { id: true, createdAt: true },
        }),
    });

    const messages = await this.prisma.message.findMany({
      where: {
        conversationId,
        ...(cursorWhere ? { AND: [cursorWhere] } : {}),
      },
      include: {
        sender: {
          select: {
            id: true,
            username: true,
            name: true,
            premium: true,
            premiumPlus: true,
            verifiedStatus: true,
            avatarKey: true,
            avatarUpdatedAt: true,
          },
        },
      },
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      take: limit + 1,
    });

    const slice = messages.slice(0, limit);
    const nextCursor = messages.length > limit ? slice[slice.length - 1]?.id ?? null : null;
    const publicBaseUrl = this.appConfig.r2()?.publicBaseUrl ?? null;
    return {
      messages: slice.map((message) => toMessageDto({ message, publicBaseUrl })),
      nextCursor,
    };
  }

  async createConversation(params: {
    userId: string;
    recipientUserIds: string[];
    title?: string | null;
    body: string;
  }) {
    const { userId, recipientUserIds, title, body } = params;
    const trimmed = (body ?? '').trim();
    if (!trimmed) throw new BadRequestException('Message body is required.');
    if (trimmed.length > MESSAGE_BODY_MAX) throw new BadRequestException('Message body is too long.');

    const uniqueRecipients = [...new Set(recipientUserIds.filter(Boolean))].filter((id) => id !== userId);
    if (uniqueRecipients.length === 0) throw new BadRequestException('At least one recipient is required.');
    await this.assertNotBlocked(userId, uniqueRecipients);

    const users = await this.prisma.user.findMany({
      where: { id: { in: uniqueRecipients } },
      select: { id: true },
    });
    if (users.length !== uniqueRecipients.length) throw new NotFoundException('User not found.');

    const isDirect = uniqueRecipients.length === 1;
    const type: MessageConversation['type'] = isDirect ? 'direct' : 'group';
    const directKey = isDirect ? this.directKeyFor(userId, uniqueRecipients[0]) : null;

    if (directKey) {
      const existing = await this.prisma.messageConversation.findFirst({
        where: { type: 'direct', directKey },
        select: { id: true },
      });
      if (existing) {
        const sent = await this.sendMessage({ userId, conversationId: existing.id, body: trimmed });
        return { conversationId: existing.id, message: sent.message };
      }
    }

    const followers = await this.prisma.follow.findMany({
      where: {
        followingId: userId,
        followerId: { in: uniqueRecipients },
      },
      select: { followerId: true },
    });
    const followerSet = new Set(followers.map((f) => f.followerId));
    const now = new Date();

    const result = await this.prisma.$transaction(async (tx) => {
      const conversation = await tx.messageConversation.create({
        data: {
          type,
          title: title?.trim() || null,
          createdByUserId: userId,
          directKey: directKey ?? undefined,
          lastMessageAt: now,
        },
      });

      const participantRows = [
        {
          conversationId: conversation.id,
          userId,
          role: 'owner' as const,
          status: 'accepted' as const,
          acceptedAt: now,
          lastReadAt: now,
        },
        ...uniqueRecipients.map((recipientId) => ({
          conversationId: conversation.id,
          userId: recipientId,
          role: 'member' as const,
          status: followerSet.has(recipientId) ? ('accepted' as const) : ('pending' as const),
          acceptedAt: followerSet.has(recipientId) ? now : null,
        })),
      ];

      await tx.messageParticipant.createMany({ data: participantRows });

      const message = await tx.message.create({
        data: {
          conversationId: conversation.id,
          senderId: userId,
          body: trimmed,
        },
        include: {
          sender: {
            select: {
              id: true,
              username: true,
              name: true,
              premium: true,
              premiumPlus: true,
              verifiedStatus: true,
              avatarKey: true,
              avatarUpdatedAt: true,
            },
          },
        },
      });

      await tx.messageConversation.update({
        where: { id: conversation.id },
        data: { lastMessageId: message.id, lastMessageAt: now },
      });

      return { conversationId: conversation.id, message };
    });

    const publicBaseUrl = this.appConfig.r2()?.publicBaseUrl ?? null;
    const dto = toMessageDto({ message: result.message, publicBaseUrl });
    const senderName =
      result.message.sender?.name?.trim() ||
      result.message.sender?.username?.trim() ||
      'Someone';

    this.emitUnreadCounts(userId);
    this.presenceGateway.emitMessageCreated(userId, { conversationId: result.conversationId, message: dto });
    for (const recipientId of uniqueRecipients) {
      this.emitUnreadCounts(recipientId);
      this.presenceGateway.emitMessageCreated(recipientId, { conversationId: result.conversationId, message: dto });
    }
    const acceptedRecipientIds = uniqueRecipients.filter((id) => followerSet.has(id));
    for (const recipientId of acceptedRecipientIds) {
      void this.notificationsService.sendMessagePush({
        recipientUserId: recipientId,
        senderName,
        body: trimmed,
        conversationId: result.conversationId,
      });
    }

    return {
      conversationId: result.conversationId,
      message: dto,
    };
  }

  async sendMessage(params: { userId: string; conversationId: string; body: string }) {
    const { userId, conversationId } = params;
    const trimmed = (params.body ?? '').trim();
    if (!trimmed) throw new BadRequestException('Message body is required.');
    if (trimmed.length > MESSAGE_BODY_MAX) throw new BadRequestException('Message body is too long.');

    const conversation = await this.getConversationOrThrow({ userId, conversationId });
    const participant = conversation.participants.find((p) => p.userId === userId);
    if (!participant) throw new NotFoundException('Conversation not found.');

    const blockedIds = await this.getBlockedUserIds(userId);
    const otherIds = conversation.participants.filter((p) => p.userId !== userId).map((p) => p.userId);
    for (const otherId of otherIds) {
      if (blockedIds.has(otherId)) throw new ForbiddenException('You cannot message this user.');
    }

    const now = new Date();
    const result = await this.prisma.$transaction(async (tx) => {
      const message = await tx.message.create({
        data: {
          conversationId,
          senderId: userId,
          body: trimmed,
        },
        include: {
          sender: {
            select: {
              id: true,
              username: true,
              name: true,
              premium: true,
              premiumPlus: true,
              verifiedStatus: true,
              avatarKey: true,
              avatarUpdatedAt: true,
            },
          },
        },
      });

      await tx.messageConversation.update({
        where: { id: conversationId },
        data: { lastMessageId: message.id, lastMessageAt: now },
      });

      await tx.messageParticipant.update({
        where: { conversationId_userId: { conversationId, userId } },
        data: { lastReadAt: now, status: 'accepted', acceptedAt: participant.acceptedAt ?? now },
      });

      if (conversation.type === 'direct' && participant.status === 'pending') {
        await tx.messageParticipant.updateMany({
          where: { conversationId, status: 'pending' },
          data: { status: 'accepted', acceptedAt: now },
        });
      }

      return message;
    });

    const publicBaseUrl = this.appConfig.r2()?.publicBaseUrl ?? null;
    const dto = toMessageDto({ message: result, publicBaseUrl });
    const senderName =
      result.sender?.name?.trim() ||
      result.sender?.username?.trim() ||
      'Someone';
    for (const id of [userId, ...otherIds]) {
      this.presenceGateway.emitMessageCreated(id, { conversationId, message: dto });
      this.emitUnreadCounts(id);
    }
    const pushRecipients = conversation.participants.filter(
      (p) => p.userId !== userId && p.status !== 'pending',
    );
    for (const recipient of pushRecipients) {
      void this.notificationsService.sendMessagePush({
        recipientUserId: recipient.userId,
        senderName,
        body: trimmed,
        conversationId,
      });
    }

    return { message: dto };
  }

  async markRead(params: { userId: string; conversationId: string }) {
    const { userId, conversationId } = params;
    await this.getConversationOrThrow({ userId, conversationId });
    await this.prisma.messageParticipant.update({
      where: { conversationId_userId: { conversationId, userId } },
      data: { lastReadAt: new Date() },
    });
    this.emitUnreadCounts(userId);
  }

  async acceptConversation(params: { userId: string; conversationId: string }) {
    const { userId, conversationId } = params;
    const conversation = await this.getConversationOrThrow({ userId, conversationId });
    const now = new Date();
    if (conversation.type === 'direct') {
      await this.prisma.messageParticipant.updateMany({
        where: { conversationId, status: 'pending' },
        data: { status: 'accepted', acceptedAt: now },
      });
    } else {
      await this.prisma.messageParticipant.update({
        where: { conversationId_userId: { conversationId, userId } },
        data: { status: 'accepted', acceptedAt: now },
      });
    }
    this.emitUnreadCounts(userId);
  }

  async blockUser(params: { userId: string; targetUserId: string }) {
    const { userId, targetUserId } = params;
    if (userId === targetUserId) throw new BadRequestException('You cannot block yourself.');
    await this.prisma.userBlock.upsert({
      where: { blockerId_blockedId: { blockerId: userId, blockedId: targetUserId } },
      create: { blockerId: userId, blockedId: targetUserId },
      update: {},
    });
    this.emitUnreadCounts(userId);
  }

  async unblockUser(params: { userId: string; targetUserId: string }) {
    const { userId, targetUserId } = params;
    await this.prisma.userBlock.deleteMany({
      where: { blockerId: userId, blockedId: targetUserId },
    });
    this.emitUnreadCounts(userId);
  }

  async listBlocks(params: { userId: string }) {
    const rows = await this.prisma.userBlock.findMany({
      where: { blockerId: params.userId },
      include: {
        blocked: {
          select: {
            id: true,
            username: true,
            name: true,
            premium: true,
            premiumPlus: true,
            verifiedStatus: true,
            avatarKey: true,
            avatarUpdatedAt: true,
          },
        },
      },
      orderBy: [{ createdAt: 'desc' }, { blockedId: 'desc' }],
    });
    const publicBaseUrl = this.appConfig.r2()?.publicBaseUrl ?? null;
    return rows.map((row) => ({
      blocked: toUserListDto(row.blocked, publicBaseUrl),
      createdAt: row.createdAt.toISOString(),
    }));
  }

  async getUnreadSummary(userId: string) {
    return await this.getUnreadCounts(userId);
  }
}
