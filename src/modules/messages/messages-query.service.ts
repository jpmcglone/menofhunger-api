import { lookupConversation } from "./conversation-lookup";
import { messageMediaDeletedAt } from "./message-media-state";
import { Injectable, NotFoundException } from "@nestjs/common";
import { clampLimit } from "../../common/pagination/page";
import { PrismaService } from "../prisma/prisma.service";
import { AppConfigService } from "../app/app-config.service";

import { createdAtIdCursorWhere } from "../../common/pagination/created-at-id-cursor";
import {
  toMessageDto,
  toMessageParticipantDto,
  toMessageConversationCrewSummaryDto,
  toLastMessagePreviewDto,
  type MessageConversationDto,
  type MessageDto,
} from "./message.dto";

import { CallSessionStore } from "../calls/call-session.store";

import { MESSAGE_PARTICIPANT_USER_SELECT } from "../../common/prisma-selects/user.select";
import {
  MessagesSupportService,
  CONVERSATION_LIST_LIMIT,
  MESSAGE_LIST_LIMIT,
  MESSAGE_INCLUDE,
  LAST_MESSAGE_PREVIEW_SELECT,
} from "./messages-support.service";

import { toPage } from "../../common/pagination/page";
import { GROUP_CARD_SELECT } from "../../common/prisma-selects/group.select";

@Injectable()
export class MessagesQueryService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly appConfig: AppConfigService,
    private readonly callSessions: CallSessionStore,
    private readonly support: MessagesSupportService,
  ) {}

  async listConversations(params: {
    userId: string;
    tab: "primary" | "requests";
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
              {
                AND: [
                  { updatedAt: new Date(cursor.updatedAt) },
                  { id: { lt: cursor.id } },
                ],
              },
            ],
          }
        : null;

    const conversations = await this.prisma.messageConversation.findMany({
      where: {
        ...(cursorWhere ? { AND: [cursorWhere] } : {}),
        type: { not: "channel" },
        participants: {
          some: {
            userId,
            status: tab === "primary" ? "accepted" : "pending",
          },
          ...(blockedUserIds.size > 0
            ? { none: { userId: { in: [...blockedUserIds] } } }
            : {}),
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
          select: GROUP_CARD_SELECT,
        },
      } as const,
      orderBy: [{ updatedAt: "desc" }, { id: "desc" }],
      take: limit + 1,
    });

    const { items: slice, nextCursor } = toPage(conversations, limit, (c) =>
      this.support.encodeConversationCursor({
        updatedAt: c.updatedAt.toISOString(),
        id: c.id,
      }),
    );

    const publicBaseUrl = this.appConfig.r2()?.publicBaseUrl ?? null;
    const perConversation = slice
      .map((conversation) => {
        const viewerParticipant = conversation.participants.find(
          (p) => p.userId === userId,
        );
        if (!viewerParticipant) {
          this.support.logger.warn(
            `listConversations: missing viewer participant (userId=${userId} conversationId=${conversation.id})`,
          );
          return null;
        }
        return {
          conversationId: conversation.id,
          lastReadAt: viewerParticipant.lastReadAt ?? null,
        };
      })
      .filter((v): v is { conversationId: string; lastReadAt: Date | null } =>
        Boolean(v),
      );
    const unreadCountByConversationId =
      await this.support.getUnreadCountByConversationId({
        userId,
        perConversation,
      });
    const activeCalls = await this.callSessions.getManyByConversationIds(
      slice.map((c) => c.id),
    );

    const items = slice
      .map((conversation): MessageConversationDto | null => {
        const viewerParticipant = conversation.participants.find(
          (p) => p.userId === userId,
        );
        if (!viewerParticipant) {
          // Shouldn't happen due to query filter, but avoid taking down the whole list if data is inconsistent.
          this.support.logger.warn(
            `listConversations: skipping conversation without viewer participant (userId=${userId} conversationId=${conversation.id})`,
          );
          return null;
        }
        const unreadCount =
          unreadCountByConversationId.get(conversation.id) ?? 0;

        return {
          id: conversation.id,
          type: this.support.chatConversationType(conversation.type),
          title: conversation.title ?? null,
          createdAt: conversation.createdAt.toISOString(),
          updatedAt: conversation.updatedAt.toISOString(),
          lastMessageAt: conversation.lastMessageAt
            ? conversation.lastMessageAt.toISOString()
            : null,
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

  async searchConversations(params: {
    userId: string;
    query: string;
    limit?: number;
  }) {
    const { userId } = params;
    const q = (params.query ?? "").trim();
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
      select: GROUP_CARD_SELECT,
    };
    const participantFilter = {
      some: { userId, status: "accepted" as const },
      ...(blockedList.length > 0
        ? { none: { userId: { in: blockedList } } }
        : {}),
    };

    // ── 1. Search by conversation title or participant name/username ──────────
    const byNameConversations = await this.prisma.messageConversation.findMany({
      where: {
        type: { not: "channel" },
        participants: participantFilter,
        OR: [
          { title: { contains: q, mode: "insensitive" } },
          {
            participants: {
              some: {
                userId: { not: userId },
                user: {
                  OR: [
                    { name: { contains: q, mode: "insensitive" } },
                    { username: { contains: q, mode: "insensitive" } },
                  ],
                },
              },
            },
          },
        ],
      },
      include: {
        participants: participantInclude,
        lastMessage: lastMessageSelect,
        crewWall: crewWallSelect,
      },
      orderBy: [{ updatedAt: "desc" }, { id: "desc" }],
      take: limit,
    });

    // ── 2. Search message bodies (trigram GIN index on Message.body) ──────────
    // Finds the most-recent matching message per conversation, skipping conversations
    // already surfaced by the name search and any blocked conversations.
    const nameMatchIds = new Set(byNameConversations.map((c) => c.id));

    type MessageHitRow = {
      conversationId: string;
      messageId: string;
      body: string;
      createdAt: Date;
    };
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

    const byMessageConversations =
      newMessageHitIds.length > 0
        ? await this.prisma.messageConversation.findMany({
            where: { id: { in: newMessageHitIds }, type: { not: "channel" } },
            include: {
              participants: participantInclude,
              lastMessage: lastMessageSelect,
              crewWall: crewWallSelect,
            },
          })
        : [];

    // Build a map from conversationId → matched message for the snippet.
    const matchedMessageByConvId = new Map(
      messageHits.map((h) => [
        h.conversationId,
        { id: h.messageId, body: h.body, createdAt: h.createdAt },
      ]),
    );

    // ── 3. Merge + deduplicate, name matches first ─────────────────────────────
    const allConversations = [
      ...byNameConversations,
      ...byMessageConversations,
    ];
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
        return vp
          ? { conversationId: c.id, lastReadAt: vp.lastReadAt ?? null }
          : null;
      })
      .filter((v): v is { conversationId: string; lastReadAt: Date | null } =>
        Boolean(v),
      );
    const unreadCountByConversationId =
      await this.support.getUnreadCountByConversationId({
        userId,
        perConversation,
      });

    const items = unique
      .map((conversation): MessageConversationDto | null => {
        const viewerParticipant = conversation.participants.find(
          (p) => p.userId === userId,
        );
        if (!viewerParticipant) return null;
        const unreadCount =
          unreadCountByConversationId.get(conversation.id) ?? 0;
        const hit = matchedMessageByConvId.get(conversation.id);
        return {
          id: conversation.id,
          type: this.support.chatConversationType(conversation.type),
          title: conversation.title ?? null,
          createdAt: conversation.createdAt.toISOString(),
          updatedAt: conversation.updatedAt.toISOString(),
          lastMessageAt: conversation.lastMessageAt
            ? conversation.lastMessageAt.toISOString()
            : null,
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
          matchedMessage: hit
            ? {
                id: hit.id,
                body: hit.body,
                createdAt: hit.createdAt.toISOString(),
              }
            : null,
          crew: toMessageConversationCrewSummaryDto({
            crewWall: conversation.crewWall ?? null,
            publicBaseUrl,
          }),
        };
      })
      .filter((v): v is MessageConversationDto => Boolean(v));

    return { conversations: items };
  }

  async lookupConversation(params: {
    userId: string;
    recipientUserIds: string[];
  }) {
    return lookupConversation(this.prisma, this.support, params);
  }

  async getConversation(params: { userId: string; conversationId: string }) {
    const { userId, conversationId } = params;
    const conversation = await this.support.getConversationOrThrow({
      userId,
      conversationId,
    });
    const viewerParticipant = conversation.participants.find(
      (p) => p.userId === userId,
    );
    if (!viewerParticipant)
      throw new NotFoundException("Conversation not found.");

    const publicBaseUrl = this.appConfig.r2()?.publicBaseUrl ?? null;
    const unreadCount = await this.support.getUnreadCount({
      userId,
      conversationId,
      lastReadAt: viewerParticipant.lastReadAt,
    });
    const otherParticipant =
      conversation.type === "direct"
        ? (conversation.participants.find((p) => p.userId !== userId) ?? null)
        : null;
    const isBlockedWith = otherParticipant
      ? await this.support.isBlockedBetween(userId, otherParticipant.userId)
      : false;
    const activeCallRecord = await this.callSessions
      .getByConversationId(conversationId)
      .catch(() => null);

    const dto: MessageConversationDto = {
      id: conversation.id,
      type: this.support.chatConversationType(conversation.type),
      title: conversation.title ?? null,
      createdAt: conversation.createdAt.toISOString(),
      updatedAt: conversation.updatedAt.toISOString(),
      lastMessageAt: conversation.lastMessageAt
        ? conversation.lastMessageAt.toISOString()
        : null,
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
      activeCall: activeCallRecord
        ? CallSessionStore.toDto(activeCallRecord)
        : null,
    };

    const messages = await this.listMessages({
      userId,
      conversationId,
      limit: MESSAGE_LIST_LIMIT,
    });
    return {
      conversation: dto,
      messages: messages.messages,
      nextCursor: messages.nextCursor,
    };
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
      orderBy: [{ createdAt: "desc" }, { id: "desc" }],
      take: limit + 1,
    });

    const { items: slice, nextCursor: nextCursor } = toPage(
      messages,
      limit,
      (r) => r.id,
    );
    const publicBaseUrl = this.appConfig.r2()?.publicBaseUrl ?? null;
    const mediaDeletedAt = await messageMediaDeletedAt(this.prisma, slice);
    return {
      messages: slice.map((message) =>
        toMessageDto({
          message,
          publicBaseUrl,
          viewerUserId: userId,
          mediaDeletedAt,
        }),
      ),
      nextCursor,
    };
  }

  /**
   * Returns a window of messages centered on `messageId`.
   * `half` messages before + the target + `half` messages after.
   * Also returns `olderCursor` (for load-older) and `newerCursor` (null = already at latest).
   */
  async messagesAround(params: {
    userId: string;
    conversationId: string;
    messageId: string;
    half?: number;
  }) {
    const { userId, conversationId, messageId } = params;
    const half = clampLimit(params.half, { default: 25, max: 50 });
    await this.support.getConversationOrThrow({ userId, conversationId });

    const target = await this.prisma.message.findFirst({
      where: { id: messageId, conversationId },
      include: MESSAGE_INCLUDE,
    });
    if (!target) throw new NotFoundException("Message not found.");

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
      orderBy: [{ createdAt: "desc" }, { id: "desc" }],
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
      orderBy: [{ createdAt: "asc" }, { id: "asc" }],
      take: half + 1,
    });

    const hasOlderBeyond = before.length > half;
    const hasNewerBeyond = after.length > half;

    const beforeSlice = before.slice(0, half).reverse(); // oldest-first
    const afterSlice = after.slice(0, half); // already oldest-first

    const allMessages = [...beforeSlice, target, ...afterSlice];
    const olderCursor = hasOlderBeyond ? (beforeSlice[0]?.id ?? null) : null;
    const newerCursor = hasNewerBeyond
      ? (afterSlice[afterSlice.length - 1]?.id ?? null)
      : null;

    const publicBaseUrl = this.appConfig.r2()?.publicBaseUrl ?? null;
    const mediaDeletedAt = await messageMediaDeletedAt(
      this.prisma,
      allMessages,
    );
    return {
      messages: allMessages.map((m) =>
        toMessageDto({
          message: m,
          publicBaseUrl,
          viewerUserId: userId,
          mediaDeletedAt,
        }),
      ),
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
    const limit = clampLimit(params.limit, {
      default: MESSAGE_LIST_LIMIT,
      max: 100,
    });
    await this.support.getConversationOrThrow({ userId, conversationId });

    const cursorMsg = await this.prisma.message.findFirst({
      where: { id: cursor, conversationId },
      select: { id: true, createdAt: true },
    });
    if (!cursorMsg) throw new NotFoundException("Cursor message not found.");

    const messages = await this.prisma.message.findMany({
      where: {
        conversationId,
        OR: [
          { createdAt: { gt: cursorMsg.createdAt } },
          { createdAt: cursorMsg.createdAt, id: { gt: cursorMsg.id } },
        ],
      },
      include: MESSAGE_INCLUDE,
      orderBy: [{ createdAt: "asc" }, { id: "asc" }],
      take: limit + 1,
    });

    const { items: slice, nextCursor: newerCursor } = toPage(
      messages,
      limit,
      (r) => r.id,
    );
    const publicBaseUrl = this.appConfig.r2()?.publicBaseUrl ?? null;
    const mediaDeletedAt = await messageMediaDeletedAt(this.prisma, slice);
    return {
      messages: slice.map((m) =>
        toMessageDto({
          message: m,
          publicBaseUrl,
          viewerUserId: userId,
          mediaDeletedAt,
        }),
      ),
      newerCursor,
    };
  }
}
