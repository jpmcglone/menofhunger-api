import { Injectable, NotFoundException } from "@nestjs/common";
import { Prisma } from "@prisma/client";
import { PrismaService } from "../prisma/prisma.service";
import { AppConfigService } from "../app/app-config.service";
import { PresenceRealtimeService } from "../presence/presence-realtime.service";
import { DomainEventsService } from "../events/domain-events.service";
import { RedisService } from "../redis/redis.service";
import { createdAtIdCursorWhere } from "../../common/pagination/created-at-id-cursor";
import {
  toMessageDto,
  toMessageParticipantDto,
  toMessageConversationCrewSummaryDto,
  toLastMessagePreviewDto,
  type MessageConversationDto,
  type MessageDto,
} from "./message.dto";
import { PosthogService } from "../../common/posthog/posthog.service";
import { JobsService } from "../jobs/jobs.service";
import { MarvinBotIdentityService } from "../marvin/services/marvin-bot-identity.service";
import { SideEffectsService } from "../side-effects/side-effects.service";
import { CallSessionStore } from "../calls/call-session.store";
import type { MessageCallDto } from "../../common/dto/call.dto";
import { MESSAGE_PARTICIPANT_USER_SELECT } from "../../common/prisma-selects/user.select";
import { MessagesSupportService, CONVERSATION_LIST_LIMIT, MESSAGE_LIST_LIMIT, MESSAGE_INCLUDE, LAST_MESSAGE_PREVIEW_SELECT } from "./messages-support.service";
import type { CallConversationContext } from "./messages.models";
import { toPage } from '../../common/pagination/page';

@Injectable()
export class MessagesQueryService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly appConfig: AppConfigService,
    private readonly presenceRealtime: PresenceRealtimeService,
    private readonly events: DomainEventsService,
    private readonly redis: RedisService,
    private readonly posthog: PosthogService,
    private readonly jobs: JobsService,
    private readonly marvIdentity: MarvinBotIdentityService,
    private readonly sideEffects: SideEffectsService,
    private readonly callSessions: CallSessionStore,
    private readonly support: MessagesSupportService,
  ) {}
  async listConversationParticipantUserIds(params: { userId: string; conversationId: string }): Promise<string[]> {
    const { userId, conversationId } = params;
    const conversation = await this.support.getConversationOrThrow({ userId, conversationId });
    return conversation.participants.map((p) => p.userId);
  }

  /**
   * All participant user ids, no viewer check. Internal use only (call lifecycle fan-out
   * fired by timers where there is no acting viewer).
   */
  async listConversationMemberUserIds(conversationId: string): Promise<string[]> {
    const rows = await this.prisma.messageParticipant.findMany({
      where: { conversationId, conversation: { type: { not: 'channel' } } },
      select: { userId: true },
    });
    return rows.map((r) => r.userId);
  }

  /**
   * Membership + gating snapshot for DM calls. Same visibility rules as
   * `getConversationOrThrow` (viewer must be a participant; blocked peers hide the
   * conversation), plus the tier/admin flags the calls service gates on.
   */
  async getCallConversationContext(params: { userId: string; conversationId: string }): Promise<CallConversationContext> {
    const { userId, conversationId } = params;
    const blockedUserIds = await this.support._getBlockedUserIds(userId);
    const conversation = await this.prisma.messageConversation.findFirst({
      where: {
        id: conversationId,
        type: { not: 'channel' },
        participants: {
          some: { userId },
          ...(blockedUserIds.size > 0 ? { none: { userId: { in: [...blockedUserIds] } } } : {}),
        },
      },
      select: {
        id: true,
        type: true,
        participants: {
          select: {
            userId: true,
            status: true,
            user: {
              select: { verifiedStatus: true, siteAdmin: true, isBot: true, bannedAt: true },
            },
          },
        },
      },
    });
    if (!conversation || conversation.type === 'channel') throw new NotFoundException('Conversation not found.');

    // Callee hasn't accepted this DM: a mutual follow or a shared group chat still counts as a
    // relationship that allows calling. Skip the lookups when the thread is already accepted.
    let relationship: CallConversationContext['relationship'] = null;
    const other = conversation.type === 'direct' ? conversation.participants.find((p) => p.userId !== userId) : null;
    if (other && other.status !== 'accepted') {
      const [viewerFollows, otherFollows, sharedGroup] = await Promise.all([
        this.prisma.follow.findFirst({ where: { followerId: userId, followingId: other.userId }, select: { id: true } }),
        this.prisma.follow.findFirst({ where: { followerId: other.userId, followingId: userId }, select: { id: true } }),
        this.prisma.messageConversation.findFirst({
          where: {
            type: { in: ['group', 'crew_wall'] },
            AND: [
              { participants: { some: { userId, status: 'accepted' } } },
              { participants: { some: { userId: other.userId, status: 'accepted' } } },
            ],
          },
          select: { id: true },
        }),
      ]);
      relationship = {
        mutualFollow: Boolean(viewerFollows && otherFollows),
        sharedGroupConversation: Boolean(sharedGroup),
      };
    }

    return {
      id: conversation.id,
      type: this.support.chatConversationType(conversation.type),
      participants: conversation.participants.map((p) => ({
        userId: p.userId,
        status: p.status,
        verified: (p.user.verifiedStatus ?? 'none') !== 'none',
        siteAdmin: Boolean(p.user.siteAdmin),
        isBot: Boolean(p.user.isBot),
        banned: Boolean(p.user.bannedAt),
      })),
      relationship,
    };
  }

  /**
   * Insert the one-per-call timeline row. Flows through the normal message plumbing
   * (last-message pointer, `messages:new`, unread badge, push) so a group call start is
   * announced exactly like a message — no separate notification kind.
   */
  async createCallMessage(params: {
    conversationId: string;
    senderId: string;
    body: string;
    call: MessageCallDto;
    /** Direct rings reach iPhones via PushKit; skip the DM alert for recipients that have one. */
    skipPushIfVoipRegistered?: boolean;
  }): Promise<MessageDto> {
    const { conversationId, senderId, body, call } = params;
    const conversation = await this.prisma.messageConversation.findUnique({
      where: { id: conversationId },
      select: { id: true, type: true, participants: { select: { userId: true, status: true } } },
    });
    if (!conversation || conversation.type === 'channel') throw new NotFoundException('Conversation not found.');
    const now = new Date();
    const message = await this.prisma.$transaction(async (tx) => {
      const created = await tx.message.create({
        data: {
          conversationId,
          senderId,
          body,
          kind: 'call',
          callMeta: call as unknown as Prisma.InputJsonValue,
        },
        include: MESSAGE_INCLUDE,
      });
      await tx.messageConversation.update({
        where: { id: conversationId },
        data: { lastMessageId: created.id, lastMessageAt: now },
      });
      await tx.messageParticipant.update({
        where: { conversationId_userId: { conversationId, userId: senderId } },
        data: { lastReadAt: now },
      });
      return created;
    });

    const publicBaseUrl = this.appConfig.r2()?.publicBaseUrl ?? null;
    const dto = toMessageDto({ message, publicBaseUrl, viewerUserId: senderId });
    const participantIds = conversation.participants.map((p) => p.userId);
    for (const id of participantIds) {
      this.presenceRealtime.emitMessageCreated(id, { conversationId, message: dto });
      this.support.emitUnreadCounts(id);
    }
    const senderName = message.sender?.name?.trim() || message.sender?.username?.trim() || 'Someone';
    for (const p of conversation.participants) {
      if (p.userId === senderId || p.status === 'pending') continue;
      this.events.emitMessagePushRequested({
        recipientUserId: p.userId,
        senderUserId: senderId,
        senderName,
        body,
        conversationId,
        skipIfVoipRegistered: Boolean(params.skipPushIfVoipRegistered),
      });
    }
    return dto;
  }

  /**
   * Patch the call row in place as the call progresses. Emits `messages:edited` so open
   * chats re-render the row; deliberately leaves `editedAt` null (this isn't a user edit).
   */
  /** Re-emit a message to its participants after a server-side change such as a finished transcript. */
  async rebroadcastMessage(messageId: string): Promise<void> {
    const message = await this.prisma.message.findUnique({ where: { id: messageId }, include: MESSAGE_INCLUDE });
    if (!message) return;
    const participants = await this.prisma.messageParticipant.findMany({
      where: { conversationId: message.conversationId },
      select: { userId: true },
    });
    const publicBaseUrl = this.appConfig.r2()?.publicBaseUrl ?? null;
    for (const p of participants) {
      const dto = toMessageDto({ message, publicBaseUrl, viewerUserId: p.userId });
      this.presenceRealtime.emitMessageEdited(p.userId, { conversationId: message.conversationId, message: dto });
    }
  }

  async updateCallMessage(params: { messageId: string; body: string; call: MessageCallDto }): Promise<void> {
    const { messageId, body, call } = params;
    const existing = await this.prisma.message.findUnique({
      where: { id: messageId },
      select: { id: true, conversationId: true, kind: true },
    });
    if (!existing || existing.kind !== 'call') return;
    const updated = await this.prisma.message.update({
      where: { id: messageId },
      data: { body, callMeta: call as unknown as Prisma.InputJsonValue },
      include: MESSAGE_INCLUDE,
    });
    const participants = await this.prisma.messageParticipant.findMany({
      where: { conversationId: existing.conversationId },
      select: { userId: true },
    });
    const publicBaseUrl = this.appConfig.r2()?.publicBaseUrl ?? null;
    for (const p of participants) {
      const dto = toMessageDto({ message: updated, publicBaseUrl, viewerUserId: p.userId });
      this.presenceRealtime.emitMessageEdited(p.userId, { conversationId: existing.conversationId, message: dto });
    }
  }

  async listConversations(params: {
    userId: string;
    tab: 'primary' | 'requests';
    limit?: number;
    cursor?: string | null;
  }) {
    const { userId, tab } = params;
    const limit = params.limit ?? CONVERSATION_LIST_LIMIT;
    const cursor = this.support.decodeConversationCursor(params.cursor ?? null);
    const blockedUserIds = await this.support._getBlockedUserIds(userId);

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
        type: { not: 'channel' },
        participants: {
          some: {
            userId,
            status: tab === 'primary' ? 'accepted' : 'pending',
          },
          ...(blockedUserIds.size > 0 ? { none: { userId: { in: [...blockedUserIds] } } } : {}),
        },
      },
      include: {
        participants: {
          include: {
            user: {
              select: MESSAGE_PARTICIPANT_USER_SELECT,
            },
          },
        },
        lastMessage: {
          select: LAST_MESSAGE_PREVIEW_SELECT,
        },
        crewWall: {
          select: { id: true, slug: true, name: true, avatarImageUrl: true },
        },
      } as const,
      orderBy: [{ updatedAt: 'desc' }, { id: 'desc' }],
      take: limit + 1,
    });

    const slice = conversations.slice(0, limit);
    const nextCursor =
      conversations.length > limit
        ? this.support.encodeConversationCursor({
            updatedAt: slice[slice.length - 1]?.updatedAt.toISOString(),
            id: slice[slice.length - 1]?.id ?? '',
          })
        : null;

    const publicBaseUrl = this.appConfig.r2()?.publicBaseUrl ?? null;
    const perConversation = slice
      .map((conversation) => {
        const viewerParticipant = conversation.participants.find((p) => p.userId === userId);
        if (!viewerParticipant) {
          this.support.logger.warn(
            `listConversations: missing viewer participant (userId=${userId} conversationId=${conversation.id})`,
          );
          return null;
        }
        return { conversationId: conversation.id, lastReadAt: viewerParticipant.lastReadAt ?? null };
      })
      .filter((v): v is { conversationId: string; lastReadAt: Date | null } => Boolean(v));
    const unreadCountByConversationId = await this.support.getUnreadCountByConversationId({ userId, perConversation });
    const activeCalls = await this.callSessions.getManyByConversationIds(slice.map((c) => c.id));

    const items = slice
      .map((conversation): MessageConversationDto | null => {
      const viewerParticipant = conversation.participants.find((p) => p.userId === userId);
      if (!viewerParticipant) {
        // Shouldn't happen due to query filter, but avoid taking down the whole list if data is inconsistent.
        this.support.logger.warn(
          `listConversations: skipping conversation without viewer participant (userId=${userId} conversationId=${conversation.id})`,
        );
        return null;
      }
      const unreadCount = unreadCountByConversationId.get(conversation.id) ?? 0;

      return {
        id: conversation.id,
        type: this.support.chatConversationType(conversation.type),
        title: conversation.title ?? null,
        createdAt: conversation.createdAt.toISOString(),
        updatedAt: conversation.updatedAt.toISOString(),
        lastMessageAt: conversation.lastMessageAt ? conversation.lastMessageAt.toISOString() : null,
        lastMessage: toLastMessagePreviewDto(conversation.lastMessage),
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
        isMuted: Boolean(viewerParticipant.mutedAt),
        crew: toMessageConversationCrewSummaryDto({
          crewWall: conversation.crewWall ?? null,
          publicBaseUrl,
        }),
        activeCall: (() => {
          const rec = activeCalls.get(conversation.id);
          return rec ? CallSessionStore.toDto(rec) : null;
        })(),
      };
    })
    .filter((v): v is MessageConversationDto => Boolean(v));

    return { conversations: items, nextCursor };
  }

  async searchConversations(params: { userId: string; query: string; limit?: number }) {
    const { userId } = params;
    const q = (params.query ?? '').trim();
    const limit = Math.min(params.limit ?? 20, 50);
    if (!q) return { conversations: [] };

    const blockedUserIds = await this.support._getBlockedUserIds(userId);
    const blockedList = blockedUserIds.size > 0 ? [...blockedUserIds] : [];

    const participantInclude = {
      include: {
        user: {
          select: MESSAGE_PARTICIPANT_USER_SELECT,
        },
      },
    };
    const lastMessageSelect = { select: LAST_MESSAGE_PREVIEW_SELECT };
    const crewWallSelect = {
      select: { id: true, slug: true, name: true, avatarImageUrl: true },
    };
    const participantFilter = {
      some: { userId, status: 'accepted' as const },
      ...(blockedList.length > 0 ? { none: { userId: { in: blockedList } } } : {}),
    };

    // ── 1. Search by conversation title or participant name/username ──────────
    const byNameConversations = await this.prisma.messageConversation.findMany({
      where: {
        type: { not: 'channel' },
        participants: participantFilter,
        OR: [
          { title: { contains: q, mode: 'insensitive' } },
          {
            participants: {
              some: {
                userId: { not: userId },
                user: {
                  OR: [
                    { name: { contains: q, mode: 'insensitive' } },
                    { username: { contains: q, mode: 'insensitive' } },
                  ],
                },
              },
            },
          },
        ],
      },
      include: { participants: participantInclude, lastMessage: lastMessageSelect, crewWall: crewWallSelect },
      orderBy: [{ updatedAt: 'desc' }, { id: 'desc' }],
      take: limit,
    });

    // ── 2. Search message bodies (trigram GIN index on Message.body) ──────────
    // Finds the most-recent matching message per conversation, skipping conversations
    // already surfaced by the name search and any blocked conversations.
    const nameMatchIds = new Set(byNameConversations.map((c) => c.id));

    type MessageHitRow = { conversationId: string; messageId: string; body: string; createdAt: Date };
    const ilike = `%${q}%`;
    // Pass blocked list as a Postgres array — empty array means the NOT IN condition never fires.
    const blockedArray = blockedList as string[];
    const messageHits = await this.prisma.$queryRaw<MessageHitRow[]>`
      SELECT DISTINCT ON (m."conversationId")
        m."conversationId" AS "conversationId",
        m.id               AS "messageId",
        m.body             AS body,
        m."createdAt"      AS "createdAt"
      FROM "Message" m
      INNER JOIN "MessageParticipant" mp
        ON mp."conversationId" = m."conversationId"
        AND mp."userId"        = ${userId}
        AND mp."status"        = 'accepted'
      WHERE m."deletedForAll" = false
        AND EXISTS (SELECT 1 FROM "MessageConversation" mc WHERE mc.id = m."conversationId" AND mc.type <> 'channel')
        AND NOT EXISTS (
          SELECT 1 FROM "MessageDeletion" md
          WHERE md."messageId" = m.id AND md."userId" = ${userId}
        )
        AND m.body ILIKE ${ilike}
        AND (
          cardinality(${blockedArray}::text[]) = 0
          OR NOT EXISTS (
            SELECT 1 FROM "MessageParticipant" bp
            WHERE bp."conversationId" = m."conversationId"
              AND bp."userId" = ANY(${blockedArray}::text[])
          )
        )
      ORDER BY m."conversationId", m."createdAt" DESC
      LIMIT ${limit}
    `;

    // Fetch full conversation data for message hits not already in the name results.
    const newMessageHitIds = messageHits
      .map((h) => h.conversationId)
      .filter((id) => !nameMatchIds.has(id));

    const byMessageConversations = newMessageHitIds.length > 0
      ? await this.prisma.messageConversation.findMany({
          where: { id: { in: newMessageHitIds }, type: { not: 'channel' } },
          include: { participants: participantInclude, lastMessage: lastMessageSelect, crewWall: crewWallSelect },
        })
      : [];

    // Build a map from conversationId → matched message for the snippet.
    const matchedMessageByConvId = new Map(
      messageHits.map((h) => [h.conversationId, { id: h.messageId, body: h.body, createdAt: h.createdAt }]),
    );

    // ── 3. Merge + deduplicate, name matches first ─────────────────────────────
    const allConversations = [...byNameConversations, ...byMessageConversations];
    const seen = new Set<string>();
    const unique = allConversations.filter((c) => {
      if (seen.has(c.id)) return false;
      seen.add(c.id);
      return true;
    });

    const publicBaseUrl = this.appConfig.r2()?.publicBaseUrl ?? null;
    const perConversation = unique
      .map((c) => {
        const vp = c.participants.find((p) => p.userId === userId);
        return vp ? { conversationId: c.id, lastReadAt: vp.lastReadAt ?? null } : null;
      })
      .filter((v): v is { conversationId: string; lastReadAt: Date | null } => Boolean(v));
    const unreadCountByConversationId = await this.support.getUnreadCountByConversationId({ userId, perConversation });

    const items = unique
      .map((conversation): MessageConversationDto | null => {
        const viewerParticipant = conversation.participants.find((p) => p.userId === userId);
        if (!viewerParticipant) return null;
        const unreadCount = unreadCountByConversationId.get(conversation.id) ?? 0;
        const hit = matchedMessageByConvId.get(conversation.id);
        return {
          id: conversation.id,
          type: this.support.chatConversationType(conversation.type),
          title: conversation.title ?? null,
          createdAt: conversation.createdAt.toISOString(),
          updatedAt: conversation.updatedAt.toISOString(),
          lastMessageAt: conversation.lastMessageAt ? conversation.lastMessageAt.toISOString() : null,
          lastMessage: toLastMessagePreviewDto(conversation.lastMessage),
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
          isMuted: Boolean(viewerParticipant.mutedAt),
          matchedMessage: hit ? { id: hit.id, body: hit.body, createdAt: hit.createdAt.toISOString() } : null,
          crew: toMessageConversationCrewSummaryDto({
            crewWall: conversation.crewWall ?? null,
            publicBaseUrl,
          }),
        };
      })
      .filter((v): v is MessageConversationDto => Boolean(v));

    return { conversations: items };
  }

  async lookupConversation(params: { userId: string; recipientUserIds: string[] }) {
    const { userId, recipientUserIds } = params;
    const uniqueRecipients = [...new Set(recipientUserIds.filter(Boolean))].filter((id) => id !== userId);
    if (uniqueRecipients.length === 0) return { conversationId: null };
    await this.support.assertNotBlocked(userId, uniqueRecipients);

    // A group with Marv is not allowed; no such conversation can exist.
    if (uniqueRecipients.length > 1) {
      const marvUserId = await this.support.resolveMarvUserId();
      if (marvUserId && uniqueRecipients.includes(marvUserId)) {
        return { conversationId: null };
      }
    }

    if (uniqueRecipients.length === 1) {
      const directKey = this.support.directKeyFor(userId, uniqueRecipients[0]);
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
    const conversation = await this.support.getConversationOrThrow({ userId, conversationId });
    const viewerParticipant = conversation.participants.find((p) => p.userId === userId);
    if (!viewerParticipant) throw new NotFoundException('Conversation not found.');

    const publicBaseUrl = this.appConfig.r2()?.publicBaseUrl ?? null;
    const unreadCount = await this.support.getUnreadCount({
      userId,
      conversationId,
      lastReadAt: viewerParticipant.lastReadAt,
    });
    const otherParticipant =
      conversation.type === 'direct'
        ? conversation.participants.find((p) => p.userId !== userId) ?? null
        : null;
    const isBlockedWith = otherParticipant
      ? await this.support.isBlockedBetween(userId, otherParticipant.userId)
      : false;
    const activeCallRecord = await this.callSessions.getByConversationId(conversationId).catch(() => null);

    const dto: MessageConversationDto = {
      id: conversation.id,
      type: this.support.chatConversationType(conversation.type),
      title: conversation.title ?? null,
      createdAt: conversation.createdAt.toISOString(),
      updatedAt: conversation.updatedAt.toISOString(),
      lastMessageAt: conversation.lastMessageAt ? conversation.lastMessageAt.toISOString() : null,
      lastMessage: toLastMessagePreviewDto(conversation.lastMessage),
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
      isMuted: Boolean(viewerParticipant.mutedAt),
      isBlockedWith,
      crew: toMessageConversationCrewSummaryDto({
        crewWall: conversation.crewWall ?? null,
        publicBaseUrl,
      }),
      activeCall: activeCallRecord ? CallSessionStore.toDto(activeCallRecord) : null,
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
    await this.support.getConversationOrThrow({ userId, conversationId });

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
      include: MESSAGE_INCLUDE,
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      take: limit + 1,
    });

    const { items: slice, nextCursor: nextCursor } = toPage(messages, limit, (r) => r.id);
    const publicBaseUrl = this.appConfig.r2()?.publicBaseUrl ?? null;
    return {
      messages: slice.map((message) => toMessageDto({ message, publicBaseUrl, viewerUserId: userId })),
      nextCursor,
    };
  }

  /**
   * Returns a window of messages centered on `messageId`.
   * `half` messages before + the target + `half` messages after.
   * Also returns `olderCursor` (for load-older) and `newerCursor` (null = already at latest).
   */
  async messagesAround(params: { userId: string; conversationId: string; messageId: string; half?: number }) {
    const { userId, conversationId, messageId } = params;
    const half = Math.max(1, Math.min(params.half ?? 25, 50));
    await this.support.getConversationOrThrow({ userId, conversationId });

    const target = await this.prisma.message.findFirst({
      where: { id: messageId, conversationId },
      include: MESSAGE_INCLUDE,
    });
    if (!target) throw new NotFoundException('Message not found.');

    // Messages strictly before the target (newest first so we get the closest ones).
    const before = await this.prisma.message.findMany({
      where: {
        conversationId,
        OR: [
          { createdAt: { lt: target.createdAt } },
          { createdAt: target.createdAt, id: { lt: target.id } },
        ],
      },
      include: MESSAGE_INCLUDE,
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      take: half + 1,
    });

    // Messages strictly after the target (oldest first).
    const after = await this.prisma.message.findMany({
      where: {
        conversationId,
        OR: [
          { createdAt: { gt: target.createdAt } },
          { createdAt: target.createdAt, id: { gt: target.id } },
        ],
      },
      include: MESSAGE_INCLUDE,
      orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
      take: half + 1,
    });

    const hasOlderBeyond = before.length > half;
    const hasNewerBeyond = after.length > half;

    const beforeSlice = before.slice(0, half).reverse(); // oldest-first
    const afterSlice = after.slice(0, half);            // already oldest-first

    const allMessages = [...beforeSlice, target, ...afterSlice];
    const olderCursor = hasOlderBeyond ? (beforeSlice[0]?.id ?? null) : null;
    const newerCursor = hasNewerBeyond ? (afterSlice[afterSlice.length - 1]?.id ?? null) : null;

    const publicBaseUrl = this.appConfig.r2()?.publicBaseUrl ?? null;
    return {
      messages: allMessages.map((m) => toMessageDto({ message: m, publicBaseUrl, viewerUserId: userId })),
      olderCursor,
      newerCursor,
      targetMessageId: messageId,
    };
  }

  /**
   * Loads messages NEWER than `cursor` (exclusive), oldest-first.
   * `newerCursor` in the response is null when we've reached the head of the conversation.
   */
  async listMessagesNewer(params: {
    userId: string;
    conversationId: string;
    cursor: string;
    limit?: number;
  }): Promise<{ messages: MessageDto[]; newerCursor: string | null }> {
    const { userId, conversationId, cursor } = params;
    const limit = Math.max(1, Math.min(params.limit ?? MESSAGE_LIST_LIMIT, 100));
    await this.support.getConversationOrThrow({ userId, conversationId });

    const cursorMsg = await this.prisma.message.findFirst({
      where: { id: cursor, conversationId },
      select: { id: true, createdAt: true },
    });
    if (!cursorMsg) throw new NotFoundException('Cursor message not found.');

    const messages = await this.prisma.message.findMany({
      where: {
        conversationId,
        OR: [
          { createdAt: { gt: cursorMsg.createdAt } },
          { createdAt: cursorMsg.createdAt, id: { gt: cursorMsg.id } },
        ],
      },
      include: MESSAGE_INCLUDE,
      orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
      take: limit + 1,
    });

    const { items: slice, nextCursor: newerCursor } = toPage(messages, limit, (r) => r.id);
    const publicBaseUrl = this.appConfig.r2()?.publicBaseUrl ?? null;
    return {
      messages: slice.map((m) => toMessageDto({ message: m, publicBaseUrl, viewerUserId: userId })),
      newerCursor,
    };
  }
}
