import { Injectable, Logger } from '@nestjs/common';
import { z } from 'zod';
import { PrismaService } from '../../prisma/prisma.service';
import { CacheService } from '../../redis/cache.service';
import type { MarvAIToolCallContext } from './marvin-ai.service';
import { MarvinBotIdentityService } from './marvin-bot-identity.service';
import { MarvinContextCardService } from './marvin-context-card.service';

const RECENT_MESSAGES_DEFAULT = 10;
const RECENT_MESSAGES_MAX = 30;

const getUserBasicInfoSchema = z.object({ username: z.string().min(1).max(50) });
const getUserContextCardSchema = z.object({ username: z.string().min(1).max(50) });
const getPostSchema = z.object({ postId: z.string().min(1).max(50) });
const getPostThreadRecentMessagesSchema = z.object({
  rootPostId: z.string().min(1).max(50),
  limit: z.coerce.number().int().min(1).max(RECENT_MESSAGES_MAX).optional(),
});
const getPostThreadSummarySchema = z.object({ rootPostId: z.string().min(1).max(50) });
const getMyRecentChatMessagesSchema = z.object({
  limit: z.coerce.number().int().min(1).max(RECENT_MESSAGES_MAX).optional(),
});

// Per-tool TTLs (seconds). Tuned so the model's tool loop sees consistent data across
// rounds, and a hot thread/user doesn't repeatedly hit Postgres while several premium
// users mention @marv inside a few minutes.
const TTL_USER_BASIC = 300; // 5 min — premium/verified rarely flip
const TTL_USER_CARD = 300; // 5 min — refreshed on a 30-day cron, no rush
const TTL_POST = 30; // 30s — body edits should reflect quickly
const TTL_THREAD_RECENT = 30; // 30s — replies arrive frequently
const TTL_THREAD_SUMMARY = 300; // 5 min — only updated by summarize job
const TTL_CHAT_RECENT = 15; // 15s — keep tight, the user's own chat
const TTL_NEGATIVE = 60; // 1 min — dedupe "no_card"/"no_summary" misses

/**
 * Local tool handlers Marv calls back into via OpenAI Responses tool calls.
 *
 * The schemas live in the OpenAI Stored Prompt; this service implements the dispatch.
 * Every handler validates inputs with Zod, returns a typed object, and {@link dispatch}
 * is the JSON serialization boundary the model reads.
 *
 * Hard rules:
 *  - `get_user_context_card` / `get_user_basic_info` must respect the per-request
 *    `allowedUsernamesLower` whitelist. Marv may NOT look up arbitrary users. The
 *    whitelist check runs OUTSIDE the cache so a different request with a different
 *    whitelist cannot reuse a cached "allowed" lookup against a disallowed name.
 *  - All post lookups skip soft-deleted posts AND `onlyMe` visibility.
 *  - All outputs are kept small (≤ ~8KB) — the AI service further clamps to 8KB anyway.
 *
 * Caching: Postgres reads are wrapped in a Redis read-through cache via
 * {@link CacheService.getOrSetJson}. Negative results (no_card / no_summary) are cached
 * with a shorter TTL so repeated misses don't hammer Postgres.
 */
@Injectable()
export class MarvinToolHandlersService {
  private readonly logger = new Logger(MarvinToolHandlersService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly identity: MarvinBotIdentityService,
    private readonly cache: CacheService,
    private readonly contextCard: MarvinContextCardService,
  ) {}

  async dispatch(name: string, args: unknown, ctx: MarvAIToolCallContext): Promise<string> {
    const startedAt = Date.now();
    let result: unknown;
    try {
      result = await this.dispatchTyped(name, args, ctx);
    } catch (err) {
      this.logger.warn(
        `[marv-tools] tool="${name}" THREW in ${Date.now() - startedAt}ms: ${err instanceof Error ? err.message : String(err)}`,
      );
      throw err;
    }
    const json = JSON.stringify(result);
    const status =
      result && typeof result === 'object' && 'error' in (result as Record<string, unknown>)
        ? `error=${String((result as { error?: unknown }).error)}`
        : 'ok';
    this.logger.log(
      `[marv-tools] tool="${name}" ${status} in ${Date.now() - startedAt}ms outputLen=${json.length}`,
    );
    return json;
  }

  private async dispatchTyped(name: string, args: unknown, ctx: MarvAIToolCallContext): Promise<unknown> {
    switch (name) {
      case 'get_user_basic_info':
        return await this.getUserBasicInfo(args, ctx);
      case 'get_user_context_card':
        return await this.getUserContextCard(args, ctx);
      case 'get_post':
        return await this.getPost(args, ctx);
      case 'get_post_thread_recent_messages':
        return await this.getPostThreadRecentMessages(args, ctx);
      case 'get_post_thread_summary':
        return await this.getPostThreadSummary(args, ctx);
      case 'get_my_recent_chat_messages':
        return await this.getMyRecentChatMessages(args, ctx);
      default:
        return { error: 'unknown_tool', name };
    }
  }

  private isUsernameAllowed(usernameLower: string, ctx: MarvAIToolCallContext): boolean {
    return ctx.allowedUsernamesLower.includes(usernameLower);
  }

  private async getUserBasicInfo(rawArgs: unknown, ctx: MarvAIToolCallContext): Promise<unknown> {
    const parsed = getUserBasicInfoSchema.safeParse(rawArgs);
    if (!parsed.success) return { error: 'invalid_args' };
    const { username } = parsed.data;
    const lower = username.toLowerCase();
    if (!this.isUsernameAllowed(lower, ctx)) {
      return { error: 'username_not_allowed', note: 'You may only look up usernames mentioned in the request.' };
    }
    return await this.cache.getOrSetJson<unknown>({
      enabled: true,
      key: `marv:tool:user-basic:${lower}`,
      ttlSeconds: TTL_USER_BASIC,
      compute: async () => {
        const rows = await this.prisma.$queryRaw<Array<{
          id: string;
          username: string | null;
          name: string | null;
          premium: boolean;
          premiumPlus: boolean;
          verifiedStatus: string;
          createdAt: Date;
          isBot: boolean;
          botType: string | null;
        }>>`
          SELECT "id", "username", "name", "premium", "premiumPlus", "verifiedStatus", "createdAt", "isBot", "botType"
          FROM "User"
          WHERE LOWER("username") = ${lower}
            AND "bannedAt" IS NULL
          LIMIT 1
        `;
        const row = rows[0];
        if (!row) return { error: 'user_not_found' };
        return {
          username: row.username,
          displayName: row.name,
          isPremium: Boolean(row.premium || row.premiumPlus),
          isPremiumPlus: Boolean(row.premiumPlus),
          verifiedStatus: row.verifiedStatus,
          joinedAt: row.createdAt.toISOString(),
          isBot: row.isBot,
          isMarv: row.isBot && row.botType === 'marvin',
        };
      },
    });
  }

  private async getUserContextCard(rawArgs: unknown, ctx: MarvAIToolCallContext): Promise<unknown> {
    const parsed = getUserContextCardSchema.safeParse(rawArgs);
    if (!parsed.success) return { error: 'invalid_args' };
    const { username } = parsed.data;
    const lower = username.toLowerCase();
    if (!this.isUsernameAllowed(lower, ctx)) {
      return { error: 'username_not_allowed' };
    }

    const cacheKey = `marv:tool:user-card:${lower}`;

    type CardShape = { username: string | null; cardText: string; source: string; updatedAt: string };

    let card = await this.cache.getOrSetNullableJson<CardShape>({
      enabled: true,
      key: cacheKey,
      ttlSeconds: TTL_USER_CARD,
      nullTtlSeconds: TTL_NEGATIVE,
      compute: async () => {
        const row = await this.prisma.userContextCard.findFirst({
          where: { user: { username: { equals: username, mode: 'insensitive' } } },
          select: { cardText: true, source: true, updatedAt: true, user: { select: { username: true } } },
        });
        if (!row) return null;
        return {
          username: row.user.username,
          cardText: row.cardText.slice(0, 4_000),
          source: row.source,
          updatedAt: row.updatedAt.toISOString(),
        };
      },
    });

    // No card yet — generate one on the fly so Marv always has context for the
    // user he's talking to. This costs one extra "fast" model call but only
    // happens once per user; subsequent calls hit the DB/cache.
    if (!card) {
      this.logger.log(`[marv-tools] no context card for @${lower} — generating on the fly`);
      try {
        const user = await this.prisma.user.findFirst({
          where: { username: { equals: username, mode: 'insensitive' }, isBot: false, bannedAt: null },
          select: { id: true, username: true },
        });
        if (user) {
          const cardText = await this.contextCard.refreshCardForUser(user.id);
          if (cardText) {
            card = {
              username: user.username,
              cardText: cardText.slice(0, 4_000),
              source: 'generated',
              updatedAt: new Date().toISOString(),
            };
            // Overwrite the negative-cache entry so the next tool call gets the real card.
            await this.cache.setJson(cacheKey, { meta: card }, { ttlSeconds: TTL_USER_CARD });
            this.logger.log(`[marv-tools] on-the-fly card generated for @${lower} len=${cardText.length}`);
          }
        }
      } catch (err) {
        this.logger.warn(
          `[marv-tools] on-the-fly card generation failed for @${lower}: ${err instanceof Error ? err.message : String(err)}`,
        );
      }
    }

    if (!card) return { error: 'no_card', note: 'No context card available for this user.' };
    return card;
  }

  private async getPost(rawArgs: unknown, _ctx: MarvAIToolCallContext): Promise<unknown> {
    const parsed = getPostSchema.safeParse(rawArgs);
    if (!parsed.success) return { error: 'invalid_args' };
    return await this.cache.getOrSetJson<unknown>({
      enabled: true,
      key: `marv:tool:post:${parsed.data.postId}`,
      ttlSeconds: TTL_POST,
      compute: async () => {
        const post = await this.prisma.post.findFirst({
          where: { id: parsed.data.postId, deletedAt: null, visibility: { not: 'onlyMe' } },
          select: {
            id: true,
            body: true,
            createdAt: true,
            visibility: true,
            rootId: true,
            parentId: true,
            user: { select: { username: true, name: true, isBot: true } },
          },
        });
        if (!post) return { error: 'post_not_found' };
        return {
          id: post.id,
          body: (post.body ?? '').slice(0, 4_000),
          createdAt: post.createdAt.toISOString(),
          visibility: post.visibility,
          rootId: post.rootId,
          parentId: post.parentId,
          author: {
            username: post.user.username,
            displayName: post.user.name,
            isBot: post.user.isBot,
          },
        };
      },
    });
  }

  private async getPostThreadRecentMessages(rawArgs: unknown, ctx: MarvAIToolCallContext): Promise<unknown> {
    const parsed = getPostThreadRecentMessagesSchema.safeParse(rawArgs);
    if (!parsed.success) return { error: 'invalid_args' };
    const requestedRoot = parsed.data.rootPostId;
    if (ctx.rootPostId && requestedRoot !== ctx.rootPostId) {
      // Don't let the model pivot to a different thread mid-call.
      return { error: 'thread_not_in_scope' };
    }
    const limit = Math.min(RECENT_MESSAGES_MAX, parsed.data.limit ?? RECENT_MESSAGES_DEFAULT);
    return await this.cache.getOrSetJson<unknown>({
      enabled: true,
      key: `marv:tool:thread-recent:${requestedRoot}:${limit}`,
      ttlSeconds: TTL_THREAD_RECENT,
      compute: async () => {
        const root = await this.prisma.post.findFirst({
          where: { id: requestedRoot, deletedAt: null, visibility: { not: 'onlyMe' } },
          select: {
            id: true,
            body: true,
            createdAt: true,
            user: { select: { username: true, name: true, isBot: true } },
          },
        });
        if (!root) return { error: 'thread_not_found' };
        const replies = await this.prisma.post.findMany({
          where: {
            rootId: requestedRoot,
            deletedAt: null,
            visibility: { not: 'onlyMe' },
          },
          select: {
            id: true,
            body: true,
            createdAt: true,
            parentId: true,
            user: { select: { username: true, name: true, isBot: true } },
          },
          orderBy: [{ createdAt: 'desc' }],
          take: limit,
        });
        // Return oldest → newest for natural reading order.
        const orderedReplies = replies.slice().reverse();
        return {
          root: {
            id: root.id,
            body: (root.body ?? '').slice(0, 1_500),
            createdAt: root.createdAt.toISOString(),
            author: {
              username: root.user.username,
              displayName: root.user.name,
              isBot: root.user.isBot,
            },
          },
          replies: orderedReplies.map((p) => ({
            id: p.id,
            body: (p.body ?? '').slice(0, 600),
            createdAt: p.createdAt.toISOString(),
            parentId: p.parentId,
            author: {
              username: p.user.username,
              displayName: p.user.name,
              isBot: p.user.isBot,
            },
          })),
        };
      },
    });
  }

  private async getPostThreadSummary(rawArgs: unknown, ctx: MarvAIToolCallContext): Promise<unknown> {
    const parsed = getPostThreadSummarySchema.safeParse(rawArgs);
    if (!parsed.success) return { error: 'invalid_args' };
    if (ctx.rootPostId && parsed.data.rootPostId !== ctx.rootPostId) {
      return { error: 'thread_not_in_scope' };
    }
    const rootPostId = parsed.data.rootPostId;
    const result = await this.cache.getOrSetNullableJson<{
      rootPostId: string;
      summary: string;
      lastMessageIdIncluded: string | null;
      updatedAt: string;
    }>({
      enabled: true,
      key: `marv:tool:thread-summary:${rootPostId}`,
      ttlSeconds: TTL_THREAD_SUMMARY,
      nullTtlSeconds: TTL_NEGATIVE,
      compute: async () => {
        const summary = await this.prisma.marvinThreadSummary.findUnique({
          where: { rootPostId },
          select: { summary: true, updatedAt: true, lastMessageIdIncluded: true },
        });
        if (!summary) return null;
        return {
          rootPostId,
          summary: summary.summary.slice(0, 4_000),
          lastMessageIdIncluded: summary.lastMessageIdIncluded,
          updatedAt: summary.updatedAt.toISOString(),
        };
      },
    });
    if (!result) return { error: 'no_summary', note: 'Thread is short enough that no rolling summary exists yet.' };
    return result;
  }

  private async getMyRecentChatMessages(rawArgs: unknown, ctx: MarvAIToolCallContext): Promise<unknown> {
    const parsed = getMyRecentChatMessagesSchema.safeParse(rawArgs);
    if (!parsed.success) return { error: 'invalid_args' };
    if (!ctx.conversationId) return { error: 'no_conversation' };
    const limit = Math.min(RECENT_MESSAGES_MAX, parsed.data.limit ?? RECENT_MESSAGES_DEFAULT);
    const conversationId = ctx.conversationId;
    const requesterUserId = ctx.requesterUserId;
    return await this.cache.getOrSetJson<unknown>({
      enabled: true,
      key: `marv:tool:chat-recent:${conversationId}:${requesterUserId}:${limit}`,
      ttlSeconds: TTL_CHAT_RECENT,
      compute: async () => {
        const marvId = await this.identity.getMarvUserId();
        const messages = await this.prisma.message.findMany({
          where: {
            conversationId,
            deletedForAll: false,
            // Only the requester ↔ marv messages — not anything else (defensive).
            OR: [{ senderId: requesterUserId }, ...(marvId ? [{ senderId: marvId }] : [])],
          },
          select: {
            id: true,
            body: true,
            createdAt: true,
            senderId: true,
            sender: { select: { username: true, name: true, isBot: true } },
          },
          orderBy: [{ createdAt: 'desc' }],
          take: limit,
        });
        const ordered = messages.slice().reverse();
        return {
          conversationId,
          messages: ordered.map((m) => ({
            id: m.id,
            body: (m.body ?? '').slice(0, 1_000),
            createdAt: m.createdAt.toISOString(),
            senderId: m.senderId,
            sender: {
              username: m.sender.username,
              displayName: m.sender.name,
              isBot: m.sender.isBot,
            },
            fromMarv: marvId ? m.senderId === marvId : false,
          })),
        };
      },
    });
  }
}
