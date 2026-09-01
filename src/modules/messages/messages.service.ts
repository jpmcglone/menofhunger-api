import { BadRequestException, ForbiddenException, Injectable, Logger, NotFoundException } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import type { MessageConversation, PostMediaKind } from '@prisma/client';

export type MessageMediaInput =
  | {
      source: 'upload';
      kind: PostMediaKind;
      r2Key: string;
      thumbnailR2Key?: string | null;
      width?: number | null;
      height?: number | null;
      durationSeconds?: number | null;
      alt?: string | null;
    }
  | {
      source: 'giphy';
      kind: 'gif';
      url: string;
      mp4Url?: string | null;
      width?: number | null;
      height?: number | null;
      alt?: string | null;
    };
import { PrismaService } from '../prisma/prisma.service';
import { AppConfigService } from '../app/app-config.service';
import { PresenceRealtimeService } from '../presence/presence-realtime.service';
import { DomainEventsService } from '../events/domain-events.service';
import { RedisService } from '../redis/redis.service';
import { RedisKeys } from '../redis/redis-keys';
import { createdAtIdCursorWhere } from '../../common/pagination/created-at-id-cursor';
import { toUserListDto } from '../../common/dto';
import { findReactionById } from '../../common/constants/reactions';
import {
  toMessageDto,
  toMessageParticipantDto,
  toMessageConversationCrewSummaryDto,
  type MessageConversationDto,
  type MessageDto,
} from './message.dto';
import { PosthogService } from '../../common/posthog/posthog.service';
import { JobsService } from '../jobs/jobs.service';
import { JOBS } from '../jobs/jobs.constants';
import { MarvinBotIdentityService } from '../marvin/services/marvin-bot-identity.service';
import { SideEffectsService } from '../side-effects/side-effects.service';
import { CallSessionStore } from '../calls/call-session.store';
import type { MessageCallDto } from '../../common/dto/call.dto';

/** What the calls service needs to authorize a start/join without re-querying per field. */
export type CallConversationContext = {
  id: string;
  type: MessageConversation['type'];
  participants: Array<{
    userId: string;
    status: 'pending' | 'accepted';
    verified: boolean;
    siteAdmin: boolean;
    isBot: boolean;
    banned: boolean;
  }>;
  /**
   * Direct conversations only, and only when the other side hasn't accepted the thread yet:
   * the alternate ways a verified member may still call them (mutual follow, or they already
   * share a group chat). `null` when the check wasn't needed.
   */
  relationship: { mutualFollow: boolean; sharedGroupConversation: boolean } | null;
};

const MESSAGE_UNREAD_CACHE_TTL_MS = 30_000;

/**
 * Minimum interval between successive `messages:updated` socket emits per user.
 * Multiple state-changing operations in a burst (mark-read on chat open with
 * many unread, rapid send + auto-mark-read, etc.) used to re-run the unread
 * query and re-emit identical totals N times within a few milliseconds. We
 * coalesce them to one emit per window per user.
 */
const UNREAD_EMIT_COALESCE_WINDOW_MS = 250;

const CONVERSATION_LIST_LIMIT = 30;
const MESSAGE_LIST_LIMIT = 50;
const MESSAGE_BODY_MAX = 2000;

const MESSAGE_SENDER_SELECT = {
  id: true,
  username: true,
  name: true,
  premium: true,
  premiumPlus: true,
  isOrganization: true,
  verifiedStatus: true,
  avatarKey: true,
  avatarUpdatedAt: true,
  isBot: true,
} as const;

const MESSAGE_INCLUDE = {
  sender: { select: MESSAGE_SENDER_SELECT },
  reactions: {
    include: {
      user: { select: { id: true, username: true, avatarKey: true, avatarUpdatedAt: true } },
    },
    orderBy: [{ createdAt: 'asc' as const }],
  },
  deletions: { select: { userId: true } },
  replyTo: {
    include: {
      sender: { select: { username: true } },
      media: { take: 1, orderBy: [{ createdAt: 'asc' as const }] },
    },
  },
  media: true,
} satisfies Prisma.MessageInclude;

/**
 * Nested `createMany` does not populate `include: { media: true }` on the
 * returned row, so send/socket DTOs shipped empty `media` arrays. `create`
 * returns the nested rows so clients can render video/image immediately.
 */
export function messageMediaCreateData(media: MessageMediaInput[]) {
  return media.map((m) =>
    m.source === 'upload'
      ? {
          source: m.source,
          kind: m.kind,
          r2Key: m.r2Key,
          thumbnailR2Key: m.thumbnailR2Key ?? null,
          width: m.width ?? null,
          height: m.height ?? null,
          durationSeconds: m.durationSeconds ?? null,
          alt: m.alt ?? null,
        }
      : {
          source: m.source,
          kind: 'gif' as PostMediaKind,
          url: m.url,
          mp4Url: m.mp4Url ?? null,
          width: m.width ?? null,
          height: m.height ?? null,
          alt: m.alt ?? null,
        },
  );
}

/** Maximum time window (in ms) after sending a message during which it can be edited. */
const MESSAGE_EDIT_WINDOW_MS = 15 * 60 * 1000; // 15 minutes

type ConversationCursor = { updatedAt: string; id: string };

@Injectable()
export class MessagesService {
  private readonly logger = new Logger(MessagesService.name);

  /**
   * Per-user state for `emitUnreadCounts` coalescing.
   * - `timer`: a pending timer that will fire `runUnreadEmit` after the window.
   * - `lastEmitAt`: epoch ms of the last successful emit; used to compute the
   *   minimum delay before the next one can fire.
   */
  private readonly unreadEmitState = new Map<
    string,
    { timer: NodeJS.Timeout | null; lastEmitAt: number }
  >();

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
  ) {}

  /**
   * Resolve the configured Marv user id, preferring the live identity cache
   * (which seeds from `MARV_USERNAME` on boot) over the env var. Without this
   * fallback, deployments that don't pin `MARV_USER_ID` in `.env` would silently
   * skip every Marv enqueue / group-chat block — Marv would just never respond.
   */
  private async resolveMarvUserId(): Promise<string | null> {
    const cached = this.marvIdentity.cachedMarvUserId();
    if (cached) return cached;
    try {
      return await this.marvIdentity.getMarvUserId();
    } catch (err) {
      this.logger.warn(
        `[messages] Could not resolve Marv user id: ${err instanceof Error ? err.message : String(err)}`,
      );
      return this.appConfig.marvBot().userId;
    }
  }

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

  private async _getBlockedUserIds(userId: string): Promise<Set<string>> {
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
    const blocked = await this._getBlockedUserIds(userId);
    for (const otherId of otherUserIds) {
      if (blocked.has(otherId)) {
        throw new ForbiddenException('You cannot message this user.');
      }
    }
  }

  private async getConversationOrThrow(params: { userId: string; conversationId: string }) {
    const { userId, conversationId } = params;
    const blockedUserIds = await this._getBlockedUserIds(userId);
    const conversation = await this.prisma.messageConversation.findFirst({
      where: {
        id: conversationId,
        participants: {
          some: { userId },
          ...(blockedUserIds.size > 0 ? { none: { userId: { in: [...blockedUserIds] } } } : {}),
        },
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
                isOrganization: true,
                verifiedStatus: true,
                avatarKey: true,
                avatarUpdatedAt: true,
                bannedAt: true,
                isBot: true,
              },
            },
          },
        },
        lastMessage: {
          select: { id: true, body: true, createdAt: true, senderId: true },
        },
        crewWall: {
          select: { id: true, slug: true, name: true, avatarImageUrl: true },
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

  private async getUnreadCountByConversationId(params: {
    userId: string;
    perConversation: Array<{ conversationId: string; lastReadAt: Date | null }>;
  }): Promise<Map<string, number>> {
    const userId = (params.userId ?? '').trim();
    const perConversation = params.perConversation ?? [];
    if (!userId || perConversation.length === 0) return new Map<string, number>();

    const tuples = perConversation
      .map((p) => ({
        conversationId: String(p?.conversationId ?? '').trim(),
        lastReadAt: p?.lastReadAt ?? null,
      }))
      .filter((p) => p.conversationId.length > 0);
    if (tuples.length === 0) return new Map<string, number>();

    // Explicit casts prevent PostgreSQL from inferring the CTE columns as `text`,
    // which would cause a type error when comparing lastReadAt against the timestamp column.
    const values = tuples.map((t) => Prisma.sql`(${t.conversationId}::text, ${t.lastReadAt}::timestamptz)`);

    const rows = await this.prisma.$queryRaw<Array<{ conversationId: string; count: number }>>(Prisma.sql`
      WITH p("conversationId", "lastReadAt") AS (
        VALUES ${Prisma.join(values)}
      )
      SELECT
        p."conversationId" as "conversationId",
        CAST(COUNT(m."id") AS INT) as "count"
      FROM p
      LEFT JOIN "Message" m
        ON m."conversationId" = p."conversationId"
        AND m."senderId" <> ${userId}
        AND (p."lastReadAt" IS NULL OR m."createdAt" > p."lastReadAt")
      GROUP BY p."conversationId"
    `);

    const out = new Map<string, number>();
    for (const r of rows) {
      const id = String(r?.conversationId ?? '').trim();
      if (!id) continue;
      out.set(id, Math.max(0, Math.floor(r?.count ?? 0)));
    }
    return out;
  }

  private async getUnreadCounts(userId: string): Promise<{ primary: number; requests: number }> {
    const blockedUserIds = await this._getBlockedUserIds(userId);
    const participants = await this.prisma.messageParticipant.findMany({
      where: {
        userId,
        ...(blockedUserIds.size > 0
          ? { conversation: { participants: { none: { userId: { in: [...blockedUserIds] } } } } }
          : {}),
      },
      select: { conversationId: true, status: true, lastReadAt: true },
    });
    const countByConversationId = await this.getUnreadCountByConversationId({
      userId,
      perConversation: participants.map((p) => ({ conversationId: p.conversationId, lastReadAt: p.lastReadAt })),
    });
    let primary = 0;
    let requests = 0;
    for (const p of participants) {
      const count = countByConversationId.get(p.conversationId) ?? 0;
      if (p.status === 'accepted') primary += count;
      else requests += count;
    }
    return { primary, requests };
  }

  private emitUnreadCounts(userId: string): void {
    const id = (userId ?? '').trim();
    if (!id) return;

    // Bust the HTTP cache eagerly so the next /unread-count poll gets fresh
    // data even if we coalesce the socket emit.
    this.invalidateUnreadSummaryCache(id);

    const state = this.unreadEmitState.get(id) ?? { timer: null, lastEmitAt: 0 };
    if (state.timer) {
      // A run is already scheduled — it will pick up the latest counts.
      return;
    }

    const now = Date.now();
    const elapsed = now - state.lastEmitAt;
    const delay = elapsed >= UNREAD_EMIT_COALESCE_WINDOW_MS ? 0 : UNREAD_EMIT_COALESCE_WINDOW_MS - elapsed;

    state.timer = setTimeout(() => {
      // Clear timer slot BEFORE the async work so a fresh emit landing while
      // the query is in flight queues a follow-up rather than getting dropped.
      const current = this.unreadEmitState.get(id);
      if (current) current.timer = null;
      void this.runUnreadEmit(id);
    }, delay);
    state.timer.unref?.();
    this.unreadEmitState.set(id, state);
  }

  private async runUnreadEmit(userId: string): Promise<void> {
    try {
      const counts = await this.getUnreadCounts(userId);
      this.presenceRealtime.emitMessagesUpdated(userId, {
        primaryUnreadCount: counts.primary,
        requestUnreadCount: counts.requests,
      });
      this.sideEffects.dispatch('account.cluster.badge', { userId });
      const state = this.unreadEmitState.get(userId);
      if (state) {
        state.lastEmitAt = Date.now();
        // Drop idle entries so the map doesn't grow with every user who ever
        // received an unread emit on this process. A pending timer means another
        // emit is already queued — keep the entry.
        if (!state.timer) this.unreadEmitState.delete(userId);
      }
    } catch (err) {
      this.logger.warn(`emitUnreadCounts failed for userId=${userId}: ${(err as Error)?.message ?? String(err)}`);
      const state = this.unreadEmitState.get(userId);
      if (state && !state.timer) this.unreadEmitState.delete(userId);
    }
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

  /**
   * All participant user ids, no viewer check. Internal use only (call lifecycle fan-out
   * fired by timers where there is no acting viewer).
   */
  async listConversationMemberUserIds(conversationId: string): Promise<string[]> {
    const rows = await this.prisma.messageParticipant.findMany({
      where: { conversationId },
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
    const blockedUserIds = await this._getBlockedUserIds(userId);
    const conversation = await this.prisma.messageConversation.findFirst({
      where: {
        id: conversationId,
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
    if (!conversation) throw new NotFoundException('Conversation not found.');

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
            type: { not: 'direct' },
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
      type: conversation.type,
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
    if (!conversation) throw new NotFoundException('Conversation not found.');
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
      this.emitUnreadCounts(id);
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
    const cursor = this.decodeConversationCursor(params.cursor ?? null);
    const blockedUserIds = await this._getBlockedUserIds(userId);

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
          ...(blockedUserIds.size > 0 ? { none: { userId: { in: [...blockedUserIds] } } } : {}),
        },
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
                isOrganization: true,
                verifiedStatus: true,
                avatarKey: true,
                avatarUpdatedAt: true,
                bannedAt: true,
                isBot: true,
              },
            },
          },
        },
        lastMessage: {
          select: { id: true, body: true, createdAt: true, senderId: true },
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
        ? this.encodeConversationCursor({
            updatedAt: slice[slice.length - 1]?.updatedAt.toISOString(),
            id: slice[slice.length - 1]?.id ?? '',
          })
        : null;

    const publicBaseUrl = this.appConfig.r2()?.publicBaseUrl ?? null;
    const perConversation = slice
      .map((conversation) => {
        const viewerParticipant = conversation.participants.find((p) => p.userId === userId);
        if (!viewerParticipant) {
          this.logger.warn(
            `listConversations: missing viewer participant (userId=${userId} conversationId=${conversation.id})`,
          );
          return null;
        }
        return { conversationId: conversation.id, lastReadAt: viewerParticipant.lastReadAt ?? null };
      })
      .filter((v): v is { conversationId: string; lastReadAt: Date | null } => Boolean(v));
    const unreadCountByConversationId = await this.getUnreadCountByConversationId({ userId, perConversation });
    const activeCalls = await this.callSessions.getManyByConversationIds(slice.map((c) => c.id));

    const items = slice
      .map((conversation): MessageConversationDto | null => {
      const viewerParticipant = conversation.participants.find((p) => p.userId === userId);
      if (!viewerParticipant) {
        // Shouldn't happen due to query filter, but avoid taking down the whole list if data is inconsistent.
        this.logger.warn(
          `listConversations: skipping conversation without viewer participant (userId=${userId} conversationId=${conversation.id})`,
        );
        return null;
      }
      const unreadCount = unreadCountByConversationId.get(conversation.id) ?? 0;

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

    const blockedUserIds = await this._getBlockedUserIds(userId);
    const blockedList = blockedUserIds.size > 0 ? [...blockedUserIds] : [];

    const participantInclude = {
      include: {
        user: {
          select: {
            id: true,
            username: true,
            name: true,
            premium: true,
            premiumPlus: true,
            isOrganization: true,
            verifiedStatus: true,
            avatarKey: true,
            avatarUpdatedAt: true,
            bannedAt: true,
            isBot: true,
          },
        },
      },
    };
    const lastMessageSelect = { select: { id: true, body: true, createdAt: true, senderId: true } };
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
          where: { id: { in: newMessageHitIds } },
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
    const unreadCountByConversationId = await this.getUnreadCountByConversationId({ userId, perConversation });

    const items = unique
      .map((conversation): MessageConversationDto | null => {
        const viewerParticipant = conversation.participants.find((p) => p.userId === userId);
        if (!viewerParticipant) return null;
        const unreadCount = unreadCountByConversationId.get(conversation.id) ?? 0;
        const hit = matchedMessageByConvId.get(conversation.id);
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
    await this.assertNotBlocked(userId, uniqueRecipients);

    // A group with Marv is not allowed; no such conversation can exist.
    if (uniqueRecipients.length > 1) {
      const marvUserId = await this.resolveMarvUserId();
      if (marvUserId && uniqueRecipients.includes(marvUserId)) {
        return { conversationId: null };
      }
    }

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
    const otherParticipant =
      conversation.type === 'direct'
        ? conversation.participants.find((p) => p.userId !== userId) ?? null
        : null;
    const isBlockedWith = otherParticipant
      ? await this.isBlockedBetween(userId, otherParticipant.userId)
      : false;
    const activeCallRecord = await this.callSessions.getByConversationId(conversationId).catch(() => null);

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
      include: MESSAGE_INCLUDE,
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      take: limit + 1,
    });

    const slice = messages.slice(0, limit);
    const nextCursor = messages.length > limit ? slice[slice.length - 1]?.id ?? null : null;
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
    await this.getConversationOrThrow({ userId, conversationId });

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
    await this.getConversationOrThrow({ userId, conversationId });

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

    const slice = messages.slice(0, limit);
    const newerCursor = messages.length > limit ? (slice[slice.length - 1]?.id ?? null) : null;
    const publicBaseUrl = this.appConfig.r2()?.publicBaseUrl ?? null;
    return {
      messages: slice.map((m) => toMessageDto({ message: m, publicBaseUrl, viewerUserId: userId })),
      newerCursor,
    };
  }

  /**
   * Find or create a bot↔user DM conversation without sending a message.
   * Returns null when blocked, banned, or self-DM.
   *
   * Used when a canned bot DM needs an idempotency claim keyed on conversationId
   * before the first message is written.
   */
  async ensureBotDirectConversation(params: {
    botUserId: string;
    recipientUserId: string;
  }): Promise<string | null> {
    const { botUserId, recipientUserId } = params;
    if (botUserId === recipientUserId) return null;

    const blocked = await this.isBlockedBetween(botUserId, recipientUserId);
    if (blocked) {
      this.logger.debug(
        `[messages] ensureBotDirectConversation: skipping (blocked) ${botUserId}->${recipientUserId}.`,
      );
      return null;
    }

    const directKey = this.directKeyFor(botUserId, recipientUserId);
    const existing = await this.prisma.messageConversation.findFirst({
      where: { type: 'direct', directKey },
      select: { id: true },
    });
    if (existing) return existing.id;

    const recipient = await this.prisma.user.findUnique({
      where: { id: recipientUserId },
      select: { id: true, bannedAt: true },
    });
    if (!recipient) throw new NotFoundException('Recipient not found.');
    if (recipient.bannedAt) {
      this.logger.debug(
        `[messages] ensureBotDirectConversation: skipping (recipient banned) ${botUserId}->${recipientUserId}.`,
      );
      return null;
    }

    const now = new Date();
    try {
      const conversation = await this.prisma.$transaction(async (tx) => {
        const created = await tx.messageConversation.create({
          data: {
            type: 'direct',
            createdByUserId: botUserId,
            directKey,
            lastMessageAt: now,
          },
        });

        // Bot conversations are auto-accepted on both sides — recipient should not see a
        // "request" tab, since Marv only DMs in response to the user's own actions.
        await tx.messageParticipant.createMany({
          data: [
            {
              conversationId: created.id,
              userId: botUserId,
              role: 'owner' as const,
              status: 'accepted' as const,
              acceptedAt: now,
              lastReadAt: now,
            },
            {
              conversationId: created.id,
              userId: recipientUserId,
              role: 'member' as const,
              status: 'accepted' as const,
              acceptedAt: now,
            },
          ],
        });

        return created;
      });
      return conversation.id;
    } catch (err) {
      // Concurrent create on the same directKey — re-read the winner.
      if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002') {
        const raced = await this.prisma.messageConversation.findFirst({
          where: { type: 'direct', directKey },
          select: { id: true },
        });
        return raced?.id ?? null;
      }
      throw err;
    }
  }

  /**
   * Send a direct message FROM a bot account TO a user, creating the direct conversation
   * if one doesn't already exist.
   *
   * Skips the standard chat-tier gates (verified-only recipients, "premium starts new chat")
   * because bots only ever speak in response to user-initiated activity. Block checks DO
   * still apply — if the user has blocked the bot, we silently no-op.
   *
   * Used by Marv to deliver canned out-of-credits notices and AI replies in private sessions.
   */
  async sendBotDirectMessage(params: {
    botUserId: string;
    recipientUserId: string;
    body: string;
    media?: MessageMediaInput[];
  }): Promise<{ conversationId: string; message: MessageDto } | null> {
    const { botUserId, recipientUserId } = params;
    const trimmed = (params.body ?? '').trim();
    const media = params.media ?? [];
    if (!trimmed && media.length === 0) throw new BadRequestException('Message must have a body or media.');
    if (trimmed.length > MESSAGE_BODY_MAX) throw new BadRequestException('Message body is too long.');

    if (botUserId === recipientUserId) {
      throw new BadRequestException('A bot cannot DM itself.');
    }

    const conversationId = await this.ensureBotDirectConversation({ botUserId, recipientUserId });
    if (!conversationId) return null;

    const sent = await this.sendMessage({
      userId: botUserId,
      conversationId,
      body: trimmed,
      media,
    });
    return { conversationId, message: sent.message };
  }

  async createConversation(params: {
    userId: string;
    recipientUserIds: string[];
    title?: string | null;
    body: string;
    media?: MessageMediaInput[];
  }) {
    const { userId, recipientUserIds, title, body } = params;
    const trimmed = (body ?? '').trim();
    const media = params.media ?? [];
    if (!trimmed && media.length === 0) throw new BadRequestException('Message must have a body or media.');
    if (trimmed.length > MESSAGE_BODY_MAX) throw new BadRequestException('Message body is too long.');

    const uniqueRecipients = [...new Set(recipientUserIds.filter(Boolean))].filter((id) => id !== userId);
    if (uniqueRecipients.length === 0) throw new BadRequestException('At least one recipient is required.');

    // Tier rule:
    // - Site admins can start new chats with any user (verified or not) and bypass the mutual-follow gate.
    // - Verified members can start new chats only with mutuals (both follow each other).
    // - Premium members can start new chats with any verified member.
    // If a direct thread already exists (any tier), the message is routed to sendMessage directly.
    const sender = await this.prisma.user.findUnique({
      where: { id: userId },
      select: { premium: true, premiumPlus: true, verifiedStatus: true, bannedAt: true, siteAdmin: true },
    });
    if (!sender) throw new NotFoundException('User not found.');
    if (sender.bannedAt) {
      // Defense-in-depth: AuthGuard already revokes the session and throws on banned users.
      // This guards the ~30s session-cache window and any internal/job callers.
      throw new ForbiddenException({
        message: 'This account was banned. Contact an admin if you think it’s a mistake.',
        error: 'account_banned',
      });
    }
    const senderIsAdmin = Boolean(sender.siteAdmin);
    const senderIsVerified = Boolean(sender.verifiedStatus && sender.verifiedStatus !== 'none');
    const senderIsPremium = Boolean(sender.premium || sender.premiumPlus);
    if (!senderIsAdmin && !senderIsVerified && !senderIsPremium) {
      // Load-bearing gate: MessagesController no longer uses VerifiedGuard (unverified users
      // must be able to reply in admin-initiated threads). This is the primary sender check.
      throw new ForbiddenException('Verify to use chat.');
    }
    await this.assertNotBlocked(userId, uniqueRecipients);

    const isDirect = uniqueRecipients.length === 1;
    const type: MessageConversation['type'] = isDirect ? 'direct' : 'group';
    const directKey = isDirect ? this.directKeyFor(userId, uniqueRecipients[0]) : null;

    // Marv cannot be in a group conversation — only 1:1 DMs are allowed.
    if (!isDirect) {
      const marvUserId = await this.resolveMarvUserId();
      if (marvUserId && uniqueRecipients.includes(marvUserId)) {
        throw new BadRequestException('Marv cannot be added to a group chat.');
      }
    }

    if (directKey) {
      const existing = await this.prisma.messageConversation.findFirst({
        where: { type: 'direct', directKey },
        select: { id: true },
      });
      if (existing) {
        const sent = await this.sendMessage({ userId, conversationId: existing.id, body: trimmed, media });
        return { conversationId: existing.id, message: sent.message };
      }
    }

    // From this point on, we are creating a new conversation (no existing direct thread matched).
    // Rules:
    //   - Site admins can message any non-banned user regardless of verification status.
    //   - Verified senders can start a new chat only with mutuals (both follow each other).
    //   - Premium senders can start a new chat with any verified member.
    //   - Non-admin senders cannot message unverified users.

    const users = await this.prisma.user.findMany({
      where: { id: { in: uniqueRecipients } },
      select: { id: true, verifiedStatus: true, bannedAt: true },
    });
    if (users.length !== uniqueRecipients.length) throw new NotFoundException('User not found.');
    for (const u of users) {
      if (u.bannedAt) {
        throw new BadRequestException('Cannot message a banned user.');
      }
      if (!senderIsAdmin && (!u.verifiedStatus || u.verifiedStatus === 'none')) {
        throw new ForbiddenException('You can only start chats with verified members.');
      }
    }

    // For verified-only (non-premium, non-admin) senders, all recipients must be mutuals.
    if (!senderIsPremium && !senderIsAdmin) {
      const [senderFollowing, senderFollowers] = await Promise.all([
        this.prisma.follow.findMany({
          where: { followerId: userId, followingId: { in: uniqueRecipients } },
          select: { followingId: true },
        }),
        this.prisma.follow.findMany({
          where: { followingId: userId, followerId: { in: uniqueRecipients } },
          select: { followerId: true },
        }),
      ]);
      const senderFollowingSet = new Set(senderFollowing.map((f) => f.followingId));
      const senderFollowerSet = new Set(senderFollowers.map((f) => f.followerId));
      const nonMutualRecipients = uniqueRecipients.filter(
        (id) => !senderFollowingSet.has(id) || !senderFollowerSet.has(id),
      );
      if (nonMutualRecipients.length > 0) {
        throw new ForbiddenException(
          'You can only message people who follow you back. Upgrade to Premium to message any member.',
        );
      }
    }

    // followerSet is used to determine conversation status (accepted vs pending) for premium senders.
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
          // Admin-initiated threads are always accepted so the message lands in the
          // primary inbox (not the Requests tab) and push shows the real body.
          status: senderIsAdmin || followerSet.has(recipientId) ? ('accepted' as const) : ('pending' as const),
          acceptedAt: senderIsAdmin || followerSet.has(recipientId) ? now : null,
        })),
      ];

      await tx.messageParticipant.createMany({ data: participantRows });

      const message = await tx.message.create({
        data: {
          conversationId: conversation.id,
          senderId: userId,
          body: trimmed,
          ...(media.length > 0 ? { media: { create: messageMediaCreateData(media) } } : {}),
        },
        include: MESSAGE_INCLUDE,
      });

      await tx.messageConversation.update({
        where: { id: conversation.id },
        data: { lastMessageId: message.id, lastMessageAt: now },
      });

      return { conversationId: conversation.id, message };
    });

    const publicBaseUrl = this.appConfig.r2()?.publicBaseUrl ?? null;
    const dto = toMessageDto({ message: result.message, publicBaseUrl, viewerUserId: userId });
    const senderName =
      result.message.sender?.name?.trim() ||
      result.message.sender?.username?.trim() ||
      'Someone';

    this.emitUnreadCounts(userId);
    this.presenceRealtime.emitMessageCreated(userId, { conversationId: result.conversationId, message: dto });
    for (const recipientId of uniqueRecipients) {
      this.emitUnreadCounts(recipientId);
      this.presenceRealtime.emitMessageCreated(recipientId, { conversationId: result.conversationId, message: dto });
    }
    for (const recipientId of uniqueRecipients) {
      const isPending = !followerSet.has(recipientId);
      const pushBody = isPending ? 'Sent you a message request' : (trimmed || (media.length > 0 ? '📷 Sent a photo' : ''));
      this.events.emitMessagePushRequested({
        recipientUserId: recipientId,
        senderUserId: userId,
        senderName,
        body: pushBody,
        conversationId: result.conversationId,
      });
    }

    // ─── Marv: queue an AI reply for the first message, same as sendMessage() ──
    try {
      const marvCfg = this.appConfig.marvBot();
      const marvUserId = marvCfg.enabled ? await this.resolveMarvUserId() : null;
      const recipientIsMarv =
        !!marvUserId && uniqueRecipients.length === 1 && uniqueRecipients[0] === marvUserId;
      if (recipientIsMarv && trimmed.length > 0) {
        this.logger.log(
          `[marv] dm-enqueue HIT (new-conversation) msg=${result.message.id} convo=${result.conversationId} sender=${userId}`,
        );
        await this.jobs
          .enqueue(
            JOBS.marvinReplyPrivate,
            {
              conversationId: result.conversationId,
              messageId: result.message.id,
              requestingUserId: userId,
              requestedMode: null,
            },
            {
              jobId: `marv-private-${result.message.id}`,
              removeOnComplete: true,
              removeOnFail: false,
              attempts: 3,
              backoff: { type: 'exponential' as const, delay: 5000 },
            },
          )
          .then(() => {
            this.logger.log(
              `[marv] dm-enqueue ok (new-conversation) msg=${result.message.id} job=marv-private-${result.message.id}`,
            );
          })
          .catch((err) => {
            this.logger.warn(
              `[marv] Failed to enqueue private reply for new conversation message=${result.message.id}: ${
                err instanceof Error ? err.message : String(err)
              }`,
            );
          });
      }
    } catch (err) {
      this.logger.warn(
        `[marv] private-reply enqueue (new-conversation) failed: ${err instanceof Error ? err.message : String(err)}`,
      );
    }

    return {
      conversationId: result.conversationId,
      message: dto,
    };
  }

  async sendMessage(params: {
    userId: string;
    conversationId: string;
    body: string;
    replyToId?: string | null;
    media?: MessageMediaInput[];
  }) {
    const { userId, conversationId } = params;
    const trimmed = (params.body ?? '').trim();
    const media = params.media ?? [];
    if (!trimmed && media.length === 0) throw new BadRequestException('Message must have a body or media.');
    if (trimmed.length > MESSAGE_BODY_MAX) throw new BadRequestException('Message body is too long.');

    const conversation = await this.getConversationOrThrow({ userId, conversationId });
    const participant = conversation.participants.find((p) => p.userId === userId);
    if (!participant) throw new NotFoundException('Conversation not found.');

    // Defense-in-depth ban check: AuthGuard normally rejects banned users at the session
    // boundary, but this protects against stale session caches and any internal callers.
    const sender = await this.prisma.user.findUnique({
      where: { id: userId },
      select: { bannedAt: true, verifiedStatus: true, premium: true, premiumPlus: true },
    });
    if (sender?.bannedAt) {
      throw new ForbiddenException({
        message: 'This account was banned. Contact an admin if you think it’s a mistake.',
        error: 'account_banned',
      });
    }

    if (media.length > 0) {
      const viewerIsVerified = Boolean(sender?.verifiedStatus && sender.verifiedStatus !== 'none');
      const viewerIsPremium = Boolean(sender?.premium || sender?.premiumPlus);
      const hasVideo = media.some((m) => m.kind === 'video');
      const hasImageOrGif = media.some((m) => m.kind !== 'video');
      if (hasImageOrGif && !viewerIsVerified) {
        throw new ForbiddenException('Verify your account to send images and GIFs in chat.');
      }
      if (hasVideo && !viewerIsPremium) {
        throw new ForbiddenException('Video messages are for premium members only.');
      }
    }

    const blockedIds = await this._getBlockedUserIds(userId);
    const otherIds = conversation.participants.filter((p) => p.userId !== userId).map((p) => p.userId);
    for (const otherId of otherIds) {
      if (blockedIds.has(otherId)) throw new ForbiddenException('You cannot message this user.');
    }

    // Validate replyToId belongs to the same conversation.
    const replyToId = params.replyToId ?? null;
    if (replyToId) {
      const replyTarget = await this.prisma.message.findFirst({
        where: { id: replyToId, conversationId },
        select: { id: true },
      });
      if (!replyTarget) throw new BadRequestException('Reply target not found in this conversation.');
    }

    const now = new Date();
    const result = await this.prisma.$transaction(async (tx) => {
      const message = await tx.message.create({
        data: {
          conversationId,
          senderId: userId,
          body: trimmed,
          ...(replyToId ? { replyToId } : {}),
          ...(media.length > 0 ? { media: { create: messageMediaCreateData(media) } } : {}),
        },
        include: MESSAGE_INCLUDE,
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
    const dto = toMessageDto({ message: result, publicBaseUrl, viewerUserId: userId });
    const senderName =
      result.sender?.name?.trim() ||
      result.sender?.username?.trim() ||
      'Someone';
    for (const id of [userId, ...otherIds]) {
      this.presenceRealtime.emitMessageCreated(id, { conversationId, message: dto });
      this.emitUnreadCounts(id);
    }
    const pushBody = trimmed || (media.length > 0 ? '📷 Sent a photo' : '');
    const pushRecipients = conversation.participants.filter(
      (p) => p.userId !== userId && p.status !== 'pending',
    );
    for (const recipient of pushRecipients) {
      this.events.emitMessagePushRequested({
        recipientUserId: recipient.userId,
        senderUserId: userId,
        senderName,
        body: pushBody,
        conversationId,
      });
    }

    this.posthog.capture(userId, 'message_sent', {
      conversation_id: conversationId,
      conversation_type: conversation.type,
    });

    // ─── Marv: queue an AI reply when this DM is for the configured Marv bot ──
    // Decoupled from MarvinModule — we only enqueue. The processor handles all gating.
    // Resolve Marv's user id via the identity service (env var optional) so the gate
    // doesn't silently skip when `MARV_USER_ID` isn't pinned in `.env`.
    try {
      const marvCfg = this.appConfig.marvBot();
      const marvUserId = marvCfg.enabled ? await this.resolveMarvUserId() : null;
      const isDirect = conversation.type === 'direct';
      const recipientIsMarv = !!marvUserId && otherIds.length === 1 && otherIds[0] === marvUserId;
      const senderIsMarv = !!marvUserId && userId === marvUserId;
      const hasBody = trimmed.length > 0;

      if (!marvCfg.enabled) {
        this.logger.log(`[marv] dm-enqueue skip reason=marv_disabled msg=${result.id}`);
      } else if (!marvUserId) {
        this.logger.warn(`[marv] dm-enqueue skip reason=marv_user_unresolved msg=${result.id}`);
      } else if (!isDirect) {
        // Group chat or wall — never enqueue for Marv. No log needed; spammy.
      } else if (!recipientIsMarv) {
        // DM to someone else — silent skip.
      } else if (senderIsMarv) {
        this.logger.log(`[marv] dm-enqueue skip reason=sender_is_marv msg=${result.id}`);
      } else if (!hasBody) {
        this.logger.log(`[marv] dm-enqueue skip reason=empty_body msg=${result.id}`);
      } else {
        this.logger.log(
          `[marv] dm-enqueue HIT msg=${result.id} convo=${conversationId} sender=${userId}`,
        );
        await this.jobs
          .enqueue(
            JOBS.marvinReplyPrivate,
            {
              conversationId,
              messageId: result.id,
              requestingUserId: userId,
              requestedMode: null,
            },
            {
              jobId: `marv-private-${result.id}`,
              removeOnComplete: true,
              removeOnFail: false,
              attempts: 3,
              backoff: { type: 'exponential' as const, delay: 5000 },
            },
          )
          .then(() => {
            this.logger.log(`[marv] dm-enqueue ok msg=${result.id} job=marv-private-${result.id}`);
          })
          .catch((err) => {
            this.logger.warn(
              `[marv] Failed to enqueue private reply for message=${result.id}: ${
                err instanceof Error ? err.message : String(err)
              }`,
            );
          });
      }
    } catch (err) {
      this.logger.warn(
        `[marv] private-reply enqueue failed: ${err instanceof Error ? err.message : String(err)}`,
      );
    }

    return { message: dto };
  }

  async markRead(params: { userId: string; conversationId: string }) {
    const { userId, conversationId } = params;
    await this.getConversationOrThrow({ userId, conversationId });
    const now = new Date();
    const [, allParticipants] = await Promise.all([
      this.prisma.messageParticipant.update({
        where: { conversationId_userId: { conversationId, userId } },
        data: { lastReadAt: now },
      }),
      this.prisma.messageParticipant.findMany({
        where: { conversationId },
        select: { userId: true },
      }),
    ]);

    const payload = { conversationId, userId, lastReadAt: now.toISOString() };
    for (const p of allParticipants) {
      // Emit to self for cross-tab/device sync, and to others so they can update read indicators.
      this.presenceRealtime.emitMessagesRead(p.userId, payload);
    }
    this.emitUnreadCounts(userId);

    // Signal to the notifications module that this user has opened the conversation
    // so the in-app message notification can be cleared.
    this.events.emitConversationRead({ userId, conversationId });
  }

  async deleteConversation(params: { userId: string; conversationId: string }) {
    const { userId, conversationId } = params;
    // Silently succeed if the user is not a participant (idempotent).
    const participant = await this.prisma.messageParticipant.findUnique({
      where: { conversationId_userId: { conversationId, userId } },
      select: { conversationId: true },
    });
    if (!participant) return;
    await this.prisma.messageParticipant.delete({
      where: { conversationId_userId: { conversationId, userId } },
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
    // Auto-unfollow: blocker should not be following the blocked user.
    await this.prisma.follow.deleteMany({
      where: { followerId: userId, followingId: targetUserId },
    });
    this.emitUnreadCounts(userId);
    // Bust cached block sets so feed filtering reflects the new block immediately.
    void this.redis.del(RedisKeys.viewerBlockSets(userId), RedisKeys.viewerBlockSets(targetUserId)).catch(() => undefined);
    // Notify other tabs/devices of the blocker that their block/follow/filter state changed.
    this.presenceRealtime.emitUsersMeRefresh(userId, 'block_changed');
  }

  /** Returns blocked user IDs visible to other services (bidirectional). */
  async getBlockedUserIds(userId: string): Promise<Set<string>> {
    return this._getBlockedUserIds(userId);
  }

  /** Check whether a block exists in either direction between two users. */
  async isBlockedBetween(userA: string, userB: string): Promise<boolean> {
    const count = await this.prisma.userBlock.count({
      where: {
        OR: [
          { blockerId: userA, blockedId: userB },
          { blockerId: userB, blockedId: userA },
        ],
      },
    });
    return count > 0;
  }

  async unblockUser(params: { userId: string; targetUserId: string }) {
    const { userId, targetUserId } = params;
    await this.prisma.userBlock.deleteMany({
      where: { blockerId: userId, blockedId: targetUserId },
    });
    this.emitUnreadCounts(userId);
    void this.redis.del(RedisKeys.viewerBlockSets(userId), RedisKeys.viewerBlockSets(targetUserId)).catch(() => undefined);
    // Notify other tabs/devices of the unblocker that their block/follow/filter state changed.
    this.presenceRealtime.emitUsersMeRefresh(userId, 'block_changed');
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
            isOrganization: true,
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

  async getUnreadSummary(userId: string): Promise<{ primary: number; requests: number }> {
    const cacheKey = RedisKeys.messageUnreadSummary(userId);
    try {
      const cached = await this.redis.getJson<{ primary: number; requests: number }>(cacheKey);
      if (cached) return cached;
    } catch {
      // Redis unavailable — fall through to DB.
    }

    const counts = await this.getUnreadCounts(userId);

    void this.redis
      .setJson(cacheKey, counts, { ttlMs: MESSAGE_UNREAD_CACHE_TTL_MS })
      .catch(() => undefined);

    return counts;
  }

  private invalidateUnreadSummaryCache(userId: string): void {
    void this.redis.del(RedisKeys.messageUnreadSummary(userId)).catch(() => undefined);
  }

  async addReaction(params: {
    userId: string;
    conversationId: string;
    messageId: string;
    reactionId: string;
  }): Promise<MessageDto> {
    const { userId, conversationId, messageId, reactionId } = params;

    const reaction = findReactionById(reactionId);
    if (!reaction) throw new BadRequestException('Invalid reaction.');

    await this.getConversationOrThrow({ userId, conversationId });

    const message = await this.prisma.message.findFirst({
      where: { id: messageId, conversationId },
      select: { id: true },
    });
    if (!message) throw new NotFoundException('Message not found.');

    await this.prisma.messageReaction.upsert({
      where: { messageId_userId_reactionId: { messageId, userId, reactionId } },
      create: { messageId, userId, reactionId, emoji: reaction.emoji },
      update: {},
    });

    const updated = await this.prisma.message.findUniqueOrThrow({
      where: { id: messageId },
      include: MESSAGE_INCLUDE,
    });
    const publicBaseUrl = this.appConfig.r2()?.publicBaseUrl ?? null;
    const dto = toMessageDto({ message: updated, publicBaseUrl, viewerUserId: userId });

    const participants = await this.prisma.messageParticipant.findMany({
      where: { conversationId },
      select: { userId: true },
    });
    for (const p of participants) {
      const participantDto = toMessageDto({ message: updated, publicBaseUrl, viewerUserId: p.userId });
      this.presenceRealtime.emitMessageReactionUpdated(p.userId, { conversationId, message: participantDto });
    }

    return dto;
  }

  async removeReaction(params: {
    userId: string;
    conversationId: string;
    messageId: string;
    reactionId: string;
  }): Promise<void> {
    const { userId, conversationId, messageId, reactionId } = params;

    await this.getConversationOrThrow({ userId, conversationId });

    await this.prisma.messageReaction.deleteMany({
      where: { messageId, userId, reactionId },
    });

    const updated = await this.prisma.message.findFirst({
      where: { id: messageId, conversationId },
      include: MESSAGE_INCLUDE,
    });
    if (!updated) return;

    const publicBaseUrl = this.appConfig.r2()?.publicBaseUrl ?? null;
    const participants = await this.prisma.messageParticipant.findMany({
      where: { conversationId },
      select: { userId: true },
    });
    for (const p of participants) {
      const participantDto = toMessageDto({ message: updated, publicBaseUrl, viewerUserId: p.userId });
      this.presenceRealtime.emitMessageReactionUpdated(p.userId, { conversationId, message: participantDto });
    }
  }

  async deleteMessageForMe(params: { userId: string; conversationId: string; messageId: string }): Promise<void> {
    const { userId, conversationId, messageId } = params;

    await this.getConversationOrThrow({ userId, conversationId });

    const message = await this.prisma.message.findFirst({
      where: { id: messageId, conversationId },
      select: { id: true },
    });
    if (!message) throw new NotFoundException('Message not found.');

    await this.prisma.messageDeletion.upsert({
      where: { messageId_userId: { messageId, userId } },
      create: { messageId, userId },
      update: {},
    });
  }

  async restoreMessageForMe(params: { userId: string; conversationId: string; messageId: string }): Promise<void> {
    const { userId, conversationId, messageId } = params;

    await this.getConversationOrThrow({ userId, conversationId });

    await this.prisma.messageDeletion.deleteMany({
      where: { messageId, userId },
    });
  }

  async muteConversation(params: { userId: string; conversationId: string }): Promise<void> {
    const { userId, conversationId } = params;
    await this.getConversationOrThrow({ userId, conversationId });
    await this.prisma.messageParticipant.update({
      where: { conversationId_userId: { conversationId, userId } },
      data: { mutedAt: new Date() },
    });
  }

  async unmuteConversation(params: { userId: string; conversationId: string }): Promise<void> {
    const { userId, conversationId } = params;
    await this.getConversationOrThrow({ userId, conversationId });
    await this.prisma.messageParticipant.update({
      where: { conversationId_userId: { conversationId, userId } },
      data: { mutedAt: null },
    });
  }

  async editMessage(params: { userId: string; conversationId: string; messageId: string; body: string }): Promise<void> {
    const { userId, conversationId, messageId, body } = params;

    const conversation = await this.getConversationOrThrow({ userId, conversationId });

    const message = await this.prisma.message.findFirst({
      where: { id: messageId, conversationId },
      include: MESSAGE_INCLUDE,
    });
    if (!message) throw new NotFoundException('Message not found.');
    if (message.senderId !== userId) throw new ForbiddenException('You can only edit your own messages.');
    if (message.deletedForAll) throw new BadRequestException('Cannot edit a deleted message.');

    const ageMs = Date.now() - message.createdAt.getTime();
    if (ageMs > MESSAGE_EDIT_WINDOW_MS) {
      throw new BadRequestException('Messages can only be edited within 15 minutes of sending.');
    }

    const publicBaseUrl = this.appConfig.r2()?.publicBaseUrl ?? null;
    const now = new Date();
    const updated = await this.prisma.message.update({
      where: { id: messageId },
      data: { body, editedAt: now },
      include: MESSAGE_INCLUDE,
    });

    for (const p of conversation.participants) {
      const dto = toMessageDto({ message: updated, publicBaseUrl, viewerUserId: p.userId });
      this.presenceRealtime.emitMessageEdited(p.userId, { conversationId, message: dto });
    }
  }

  async deleteMessageForAll(params: { userId: string; conversationId: string; messageId: string }): Promise<void> {
    const { userId, conversationId, messageId } = params;

    const conversation = await this.getConversationOrThrow({ userId, conversationId });

    const message = await this.prisma.message.findFirst({
      where: { id: messageId, conversationId },
      select: { id: true, senderId: true, deletedForAll: true },
    });
    if (!message) throw new NotFoundException('Message not found.');
    if (message.senderId !== userId) throw new ForbiddenException('You can only delete your own messages.');
    if (message.deletedForAll) return; // idempotent

    const now = new Date();
    await this.prisma.message.update({
      where: { id: messageId },
      data: { deletedForAll: true, deletedForAllAt: now },
    });

    if (conversation.lastMessageId === messageId) {
      const prev = await this.prisma.message.findFirst({
        where: { conversationId, deletedForAll: false },
        orderBy: { createdAt: 'desc' },
        select: { id: true, body: true, createdAt: true, senderId: true },
      });
      await this.prisma.messageConversation.update({
        where: { id: conversationId },
        data: {
          lastMessageId: prev?.id ?? null,
          lastMessageAt: prev?.createdAt ?? null,
        },
      });
    }

    for (const p of conversation.participants) {
      this.presenceRealtime.emitMessageDeletedForAll(p.userId, { conversationId, messageId });
    }
  }
}
