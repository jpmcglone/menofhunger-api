import {
  decodeJsonCursor,
  encodeJsonCursor,
} from "../../common/pagination/json-cursor";
import {
  ForbiddenException,
  Injectable,
  Logger,
  NotFoundException,
} from "@nestjs/common";
import { Prisma } from "@prisma/client";
import { PrismaService } from "../prisma/prisma.service";
import { AppConfigService } from "../app/app-config.service";
import { PresenceRealtimeService } from "../presence/presence-realtime.service";
import { RedisService } from "../redis/redis.service";
import { RedisKeys } from "../redis/redis-keys";
import { type MessageConversationDto } from "./message.dto";
import { MarvinBotIdentityService } from "../marvin/services/marvin-bot-identity.service";
import { SideEffectsService } from "../side-effects/side-effects.service";
import { MESSAGE_PARTICIPANT_USER_SELECT } from "../../common/prisma-selects/user.select";
import { USER_AVATAR_BRIEF_SELECT } from "../../common/prisma-selects/user.select";
import { GROUP_CARD_SELECT } from "../../common/prisma-selects/group.select";

export type ConversationCursor = { updatedAt: string; id: string };

export const MESSAGE_UNREAD_CACHE_TTL_MS = 30_000;

/**
 * Minimum interval between successive `messages:updated` socket emits per user.
 * Multiple state-changing operations in a burst (mark-read on chat open with
 * many unread, rapid send + auto-mark-read, etc.) used to re-run the unread
 * query and re-emit identical totals N times within a few milliseconds. We
 * coalesce them to one emit per window per user.
 */
const UNREAD_EMIT_COALESCE_WINDOW_MS = 250;

export const CONVERSATION_LIST_LIMIT = 30;
export const MESSAGE_LIST_LIMIT = 50;
export const MESSAGE_BODY_MAX = 2000;

const MESSAGE_SENDER_SELECT = {
  id: true,
  username: true,
  name: true,
  premium: true,
  premiumPlus: true,
  isOrganization: true,
  verifiedStatus: true,
  avatarKey: true,
  avatarVideoKey: true,
  avatarVideoDurationMs: true,
  avatarUpdatedAt: true,
  isBot: true,
} as const;

export const MESSAGE_INCLUDE = {
  sender: { select: MESSAGE_SENDER_SELECT },
  reactions: {
    include: {
      user: { select: USER_AVATAR_BRIEF_SELECT },
    },
    orderBy: [{ createdAt: "asc" as const }],
  },
  deletions: { select: { userId: true } },
  replyTo: {
    include: {
      sender: { select: { username: true } },
      media: { take: 1, orderBy: [{ createdAt: "asc" as const }] },
    },
  },
  media: true,
} satisfies Prisma.MessageInclude;

export const LAST_MESSAGE_PREVIEW_SELECT = {
  id: true,
  body: true,
  createdAt: true,
  senderId: true,
  deletedForAll: true,
  media: {
    select: { kind: true },
    take: 1,
    orderBy: [{ createdAt: "asc" as const }],
  },
} satisfies Prisma.MessageSelect;

/** Maximum time window (in ms) after sending a message during which it can be edited. */
export const MESSAGE_EDIT_WINDOW_MS = 15 * 60 * 1000; // 15 minutes

@Injectable()
export class MessagesSupportService {
  readonly logger = new Logger(MessagesSupportService.name);
  private readonly unreadEmitState = new Map<
    string,
    { timer: NodeJS.Timeout | null; lastEmitAt: number }
  >();

  constructor(
    private readonly prisma: PrismaService,
    private readonly appConfig: AppConfigService,
    private readonly presenceRealtime: PresenceRealtimeService,

    private readonly redis: RedisService,

    private readonly marvIdentity: MarvinBotIdentityService,
    private readonly sideEffects: SideEffectsService,
  ) {}
  /**
   * Resolve the configured Marv user id, preferring the live identity cache
   * (which seeds from `MARV_USERNAME` on boot) over the env var. Without this
   * fallback, deployments that don't pin `MARV_USER_ID` in `.env` would silently
   * skip every Marv enqueue / group-chat block — Marv would just never respond.
   */
  async resolveMarvUserId(): Promise<string | null> {
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

  encodeConversationCursor(cursor: ConversationCursor): string {
    return encodeJsonCursor(cursor);
  }

  decodeConversationCursor(token: string | null): ConversationCursor | null {
    const parsed = decodeJsonCursor(token);
    if (!parsed?.updatedAt || !parsed?.id) return null;
    return { updatedAt: String(parsed.updatedAt), id: String(parsed.id) };
  }

  directKeyFor(a: string, b: string): string {
    return [a, b].sort().join(":");
  }

  async _getBlockedUserIds(userId: string): Promise<Set<string>> {
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

  async assertNotBlocked(
    userId: string,
    otherUserIds: string[],
  ): Promise<void> {
    if (otherUserIds.length === 0) return;
    const blocked = await this._getBlockedUserIds(userId);
    for (const otherId of otherUserIds) {
      if (blocked.has(otherId)) {
        throw new ForbiddenException("You cannot message this user.");
      }
    }
  }

  parseDirectPair(
    directKey: string | null | undefined,
  ): [string, string] | null {
    if (!directKey) return null;
    const parts = directKey.split(":");
    if (parts.length !== 2 || !parts[0] || !parts[1] || parts[0] === parts[1])
      return null;
    return [parts[0], parts[1]];
  }

  /**
   * Delete conversation removes the viewer's participant row, but the direct
   * thread stays (unique `directKey`). Re-add missing members so they can
   * open or message that person again instead of 404ing on the zombie thread.
   */
  async restoreMissingDirectParticipants(params: {
    conversationId: string;
    createdByUserId: string;
    userIds: string[];
  }): Promise<number> {
    const uniqueIds = [...new Set(params.userIds.filter(Boolean))];
    if (uniqueIds.length === 0) return 0;
    const existing = await this.prisma.messageParticipant.findMany({
      where: { conversationId: params.conversationId },
      select: { userId: true },
    });
    const have = new Set(existing.map((p) => p.userId));
    const missing = uniqueIds.filter((id) => !have.has(id));
    if (missing.length === 0) return 0;
    const now = new Date();
    await this.prisma.messageParticipant.createMany({
      data: missing.map((userId) => ({
        conversationId: params.conversationId,
        userId,
        role: params.createdByUserId === userId ? "owner" : "member",
        status: "accepted" as const,
        acceptedAt: now,
        lastReadAt: now,
      })),
      skipDuplicates: true,
    });
    return missing.length;
  }

  async getConversationOrThrow(params: {
    userId: string;
    conversationId: string;
  }) {
    const { userId, conversationId } = params;
    const blockedUserIds = await this._getBlockedUserIds(userId);
    const load = () =>
      this.prisma.messageConversation.findFirst({
        where: {
          id: conversationId,
          type: { not: "channel" },
          participants: {
            some: { userId },
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
        },
      });

    let conversation = await load();
    if (!conversation) {
      const raw = await this.prisma.messageConversation.findUnique({
        where: { id: conversationId },
        select: { type: true, directKey: true, createdByUserId: true },
      });
      const pair =
        raw?.type === "direct" ? this.parseDirectPair(raw.directKey) : null;
      const otherId = pair ? (pair[0] === userId ? pair[1] : pair[0]) : null;
      if (
        !raw ||
        !pair ||
        !pair.includes(userId) ||
        (otherId != null && blockedUserIds.has(otherId))
      ) {
        throw new NotFoundException("Conversation not found.");
      }
      await this.restoreMissingDirectParticipants({
        conversationId,
        createdByUserId: raw.createdByUserId,
        userIds: [userId],
      });
      conversation = await load();
      if (!conversation || conversation.type === "channel")
        throw new NotFoundException("Conversation not found.");
    }

    return conversation;
  }

  async getUnreadCount(params: {
    userId: string;
    conversationId: string;
    lastReadAt: Date | null;
  }): Promise<number> {
    const { userId, conversationId, lastReadAt } = params;
    return await this.prisma.message.count({
      where: {
        conversationId,
        senderId: { not: userId },
        ...(lastReadAt ? { createdAt: { gt: lastReadAt } } : {}),
      },
    });
  }

  async getUnreadCountByConversationId(params: {
    userId: string;
    perConversation: Array<{ conversationId: string; lastReadAt: Date | null }>;
  }): Promise<Map<string, number>> {
    const userId = (params.userId ?? "").trim();
    const perConversation = params.perConversation ?? [];
    if (!userId || perConversation.length === 0)
      return new Map<string, number>();

    const tuples = perConversation
      .map((p) => ({
        conversationId: String(p?.conversationId ?? "").trim(),
        lastReadAt: p?.lastReadAt ?? null,
      }))
      .filter((p) => p.conversationId.length > 0);
    if (tuples.length === 0) return new Map<string, number>();

    // Explicit casts prevent PostgreSQL from inferring the CTE columns as `text`,
    // which would cause a type error when comparing lastReadAt against the timestamp column.
    const values = tuples.map(
      (t) =>
        Prisma.sql`(${t.conversationId}::text, ${t.lastReadAt}::timestamptz)`,
    );

    const rows = await this.prisma.$queryRaw<
      Array<{ conversationId: string; count: number }>
    >(Prisma.sql`
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
      const id = String(r?.conversationId ?? "").trim();
      if (!id) continue;
      out.set(id, Math.max(0, Math.floor(r?.count ?? 0)));
    }
    return out;
  }

  async getUnreadCounts(
    userId: string,
  ): Promise<{ primary: number; requests: number }> {
    const blockedUserIds = await this._getBlockedUserIds(userId);
    const participants = await this.prisma.messageParticipant.findMany({
      where: {
        userId,
        ...(blockedUserIds.size > 0
          ? {
              conversation: {
                type: { not: "channel" },
                participants: { none: { userId: { in: [...blockedUserIds] } } },
              },
            }
          : { conversation: { type: { not: "channel" } } }),
      },
      select: { conversationId: true, status: true, lastReadAt: true },
    });
    const countByConversationId = await this.getUnreadCountByConversationId({
      userId,
      perConversation: participants.map((p) => ({
        conversationId: p.conversationId,
        lastReadAt: p.lastReadAt,
      })),
    });
    let primary = 0;
    let requests = 0;
    for (const p of participants) {
      const count = countByConversationId.get(p.conversationId) ?? 0;
      if (p.status === "accepted") primary += count;
      else requests += count;
    }
    return { primary, requests };
  }

  emitUnreadCounts(userId: string): void {
    const id = (userId ?? "").trim();
    if (!id) return;

    // Bust the HTTP cache eagerly so the next /unread-count poll gets fresh
    // data even if we coalesce the socket emit.
    this.invalidateUnreadSummaryCache(id);

    const state = this.unreadEmitState.get(id) ?? {
      timer: null,
      lastEmitAt: 0,
    };
    if (state.timer) {
      // A run is already scheduled — it will pick up the latest counts.
      return;
    }

    const now = Date.now();
    const elapsed = now - state.lastEmitAt;
    const delay =
      elapsed >= UNREAD_EMIT_COALESCE_WINDOW_MS
        ? 0
        : UNREAD_EMIT_COALESCE_WINDOW_MS - elapsed;

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

  async runUnreadEmit(userId: string): Promise<void> {
    try {
      const counts = await this.getUnreadCounts(userId);
      this.presenceRealtime.emitMessagesUpdated(userId, {
        primaryUnreadCount: counts.primary,
        requestUnreadCount: counts.requests,
      });
      this.sideEffects.dispatch("account.cluster.badge", { userId });
      this.sideEffects.dispatch("notification.badge.sync", {
        recipientUserId: userId,
      });
      const state = this.unreadEmitState.get(userId);
      if (state) {
        state.lastEmitAt = Date.now();
        // Drop idle entries so the map doesn't grow with every user who ever
        // received an unread emit on this process. A pending timer means another
        // emit is already queued — keep the entry.
        if (!state.timer) this.unreadEmitState.delete(userId);
      }
    } catch (err) {
      this.logger.warn(
        `emitUnreadCounts failed for userId=${userId}: ${(err as Error)?.message ?? String(err)}`,
      );
      const state = this.unreadEmitState.get(userId);
      if (state && !state.timer) this.unreadEmitState.delete(userId);
    }
  }

  chatConversationType(
    type: MessageConversationDto["type"] | "channel",
  ): MessageConversationDto["type"] {
    if (type === "channel")
      throw new NotFoundException("Conversation not found.");
    return type;
  }

  invalidateUnreadSummaryCache(userId: string): void {
    void this.redis
      .del(RedisKeys.messageUnreadSummary(userId))
      .catch(() => undefined);
  }

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
}
