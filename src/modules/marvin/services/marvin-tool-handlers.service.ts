import { NOT_BANNED_USER_WHERE } from '../../../common/prisma-selects/user.where';
import { MarvinPersonalService } from './marvin-personal.service';
import { MarvinParticipationService } from './marvin-participation.service';
import crypto from 'node:crypto';
import { Injectable, Logger } from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service';
import { CacheService } from '../../redis/cache.service';
import type { MarvAIToolCallContext } from './marvin-ai.service';
import { MarvinBotIdentityService } from './marvin-bot-identity.service';
import { MarvinContextCardService } from './marvin-context-card.service';
import { ScriptureService } from '../../scripture/scripture.service';
import { JobsService } from '../../jobs/jobs.service';
import { JOBS } from '../../jobs/jobs.constants';
import { marvPublicProfilePostWhere } from './marvin-post-access';
import { parseMentionsFromBody } from '../../../common/mentions/mention-regex';
import { AppConfigService } from '../../app/app-config.service';

import { PostsReadService } from '../../posts-read/posts-read.service';
import { MarvinPlatformContextService } from './marvin-platform-context.service';
import { PREFETCH_MEMBER_CARD_MAX, getUserBasicInfoSchema, getUserContextCardSchema, getPostSchema, PUBLIC_POSTS_DEFAULT, listPublicPostsSchema, listLimitSchema, searchGroupChannelsSchema, fetchUrlContentSchema, getBiblePassageSchema, TTL_USER_BASIC, TTL_USER_CARD, TTL_POST, TTL_PUBLIC_POSTS, TTL_URL_CONTENT, TTL_NEGATIVE, MAX_URL_CONTENT_CHARS, URL_FETCH_TIMEOUT_MS } from './marvin-tool-handlers.schemas';
import { marvPostSelect, compactMarvPost } from './marvin-tool-format';
import { MarvinChatContextToolsService } from './marvin-tool-chat-context.service';
import { MarvinMemberToolsService } from './marvin-member-tools.service';
import { NOT_DELETED } from '../../../common/prisma/where';

/**
 * Local tool handlers Marv calls back into via OpenAI Responses tool calls.
 *
 * Tool schemas are registered in `marvin-ai-tools.ts`; this service implements dispatch.
 * Every handler validates inputs with Zod, returns a typed object, and {@link dispatch}
 * is the JSON serialization boundary the model reads.
 *
 * Hard rules:
 *  - `get_user_context_card` / `get_user_basic_info` filter banned users at the SQL layer
 *    (`bannedAt IS NULL`). Profile data Marv exposes is the same data any signed-in user
 *    can see by visiting the profile page, so there is no per-request username whitelist.
 *  - A valid member always gets a card: the persisted summary if one exists, otherwise a
 *    live public-profile fallback (bio / interests / recent public posts). `user_not_found`
 *    is the only miss. Never tell the model the lookup is limited to "this session".
 *  - All post lookups skip soft-deleted posts AND `onlyMe` visibility.
 *  - All outputs are kept small (≤ ~8KB) — the AI service further clamps to 8KB anyway.
 *
 * Caching: Postgres reads are wrapped in a Redis read-through cache via
 * {@link CacheService.getOrSetJson}. Negative results (user_not_found / no_summary) are
 * cached with a shorter TTL so repeated misses don't hammer Postgres.
 */
@Injectable()
export class MarvinToolHandlersService {
  private readonly logger = new Logger(MarvinToolHandlersService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly identity: MarvinBotIdentityService,
    private readonly cache: CacheService,
    private readonly contextCard: MarvinContextCardService,
    private readonly scripture: ScriptureService,
    private readonly jobs: JobsService,
    private readonly appConfig: AppConfigService,
    private readonly personal: MarvinPersonalService,
    private readonly participation: MarvinParticipationService,
    private readonly postsRead: PostsReadService,
    private readonly platform: MarvinPlatformContextService,
    private readonly memberTools: MarvinMemberToolsService,
    private readonly chatContext: MarvinChatContextToolsService,
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
      case 'prepare_personal_action': return this.personal.prepare(args, ctx);
      case 'get_my_notification_preferences': return this.personal.readPreferences(ctx);
      case 'get_participation_suggestions':
        await this.personal.assertPrivate(ctx);
        return this.participation.suggestions(ctx.requesterUserId);
      case 'get_user_basic_info':
        return await this.getUserBasicInfo(args, ctx);
      case 'get_user_context_card':
        return await this.getUserContextCard(args);
      case 'get_post':
        return await this.getPost(args, ctx);
      case 'list_public_posts':
        return await this.listPublicPosts(args);
      case 'list_public_articles':
        return await this.listPublicArticles(args);
      case 'list_board':
        return await this.listBoard(args);
      case 'list_group_feed':
        return await this.listGroupFeed(args, ctx);
      case 'search_group_channels':
        return await this.searchGroupChannels(args, ctx);
      case 'get_post_thread_recent_messages':
        return await this.getPostThreadRecentMessages(args, ctx);
      case 'get_post_thread_summary':
        return await this.getPostThreadSummary(args, ctx);
      case 'get_my_recent_chat_messages':
        return await this.getMyRecentChatMessages(args, ctx);
      case 'fetch_url_content':
        return await this.fetchUrlContent(args);
      case 'get_bible_passage':
        return await this.getBiblePassage(args);
      case 'find_similar_members':
        return await this.findSimilarMembers(args, ctx);
      case 'find_members_by_name':
        return await this.findMembersByName(args, ctx);
      default:
        return { error: 'unknown_tool', name };
    }
  }

  private async getUserBasicInfo(rawArgs: unknown, _ctx: MarvAIToolCallContext): Promise<unknown> {
    const parsed = getUserBasicInfoSchema.safeParse(rawArgs);
    if (!parsed.success) return { error: 'invalid_args' };
    const { username } = parsed.data;
    const lower = username.toLowerCase();
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

  private async getUserContextCard(rawArgs: unknown): Promise<unknown> {
    const parsed = getUserContextCardSchema.safeParse(rawArgs);
    if (!parsed.success) return { error: 'invalid_args' };
    return await this.lookupMemberCard(parsed.data.username);
  }

  /**
   * Live member lookup used by `get_user_context_card` and by reply processors that
   * prefetch @mentioned users into the prompt. A valid member always returns a card
   * (persisted summary or live public-profile fallback). The AI card job is enqueued
   * on fallback so the next turn can be richer — we do not wait on the model here.
   */
  async lookupMemberCard(username: string): Promise<
    | { username: string | null; cardText: string; source: string; updatedAt: string }
    | { error: 'user_not_found'; note: string }
  > {
    const lower = username.toLowerCase();
    const cacheKey = `marv:tool:user-card:${lower}`;

    type CardShape = { username: string | null; cardText: string; source: string; updatedAt: string };

    const cached = await this.cache.getJson<{ meta: CardShape | null }>(cacheKey);
    if (cached && Object.prototype.hasOwnProperty.call(cached, 'meta')) {
      if (cached.meta?.cardText) return cached.meta;
      return { error: 'user_not_found', note: 'No member found with that username.' };
    }

    const live = await this.contextCard.ensureLiveCard(username);
    if (!live) {
      await this.cache.setJson(cacheKey, { meta: null }, { ttlSeconds: TTL_NEGATIVE });
      return { error: 'user_not_found', note: 'No member found with that username.' };
    }

    const card: CardShape = {
      username: live.username,
      cardText: live.cardText.slice(0, 4_000),
      source: live.source,
      updatedAt: live.updatedAt.toISOString(),
    };

    if (live.source === 'fallback') {
      this.logger.log(`[marv-tools] live fallback card for @${lower} — enqueueing generated refresh`);
      await this.jobs
        .enqueue(
          JOBS.marvinContextCardRefresh,
          { userId: live.userId },
          {
            jobId: `marvin-context-card-${live.userId}`,
            // Don't compete with the in-flight reply for OpenAI TPM.
            delay: 30_000,
          },
        )
        .catch((err) => {
          this.logger.debug(
            `[marv-tools] context-card enqueue skipped for @${lower}: ${err instanceof Error ? err.message : String(err)}`,
          );
        });
      // Short TTL so the generated job can replace this shortly.
      await this.cache.setJson(cacheKey, { meta: card }, { ttlSeconds: TTL_NEGATIVE });
    } else {
      await this.cache.setJson(cacheKey, { meta: card }, { ttlSeconds: TTL_USER_CARD });
    }

    return card;
  }

  /**
   * Prefetch cards for @mentioned members so the model has them before it answers.
   * Caps the set so a long mention list cannot blow the developer note.
   */
  async lookupMemberCards(
    usernames: string[],
  ): Promise<Array<{ username: string; cardText: string | null }>> {
    const unique = [
      ...new Set(usernames.map((u) => u.trim()).filter(Boolean).map((u) => u.toLowerCase())),
    ].slice(0, PREFETCH_MEMBER_CARD_MAX);
    return await Promise.all(
      unique.map(async (username) => {
        const result = await this.lookupMemberCard(username);
        if ('error' in result) return { username, cardText: null };
        return { username: result.username ?? username, cardText: result.cardText };
      }),
    );
  }

  /**
   * Collect public-profile cards for everyone who appears in the text Marv is
   * about to read: @mentions first (they keep the cap), then optional extra
   * handles such as post authors. Shared by DM replies, thread replies, and catch-up.
   */
  async collectMentionedMemberCards(args: {
    bodies?: Array<string | null | undefined>;
    extraUsernames?: Array<string | null | undefined>;
  }): Promise<Array<{ username: string; cardText: string | null }>> {
    const fromBodies = (args.bodies ?? []).flatMap((body) => parseMentionsFromBody(body ?? ''));
    const extra = (args.extraUsernames ?? [])
      .map((u) => (u ?? '').trim())
      .filter(Boolean);
    const marvLower = this.identity.marvUsernameLower();
    const usernames = [...fromBodies, ...extra].filter((u) => u.toLowerCase() !== marvLower);
    if (usernames.length === 0) return [];
    return await this.lookupMemberCards(usernames);
  }

  private async getPost(rawArgs: unknown, ctx: MarvAIToolCallContext): Promise<unknown> {
    const parsed = getPostSchema.safeParse(rawArgs);
    if (!parsed.success) return { error: 'invalid_args' };
    const scope = (ctx.rootPostId ?? '').trim() || '-';
    return await this.cache.getOrSetJson<unknown>({
      enabled: false,
      key: `marv:tool:post:${parsed.data.postId}:root:${scope}`,
      ttlSeconds: TTL_POST,
      compute: async () => {
        const post = await this.postsRead.findFirst({
          where: {
            id: parsed.data.postId,
            ...await this.chatContext.permittedPostWhere(ctx),
          },
          select: marvPostSelect(),
        });
        if (!post) return { error: 'post_not_found' };
        return compactMarvPost(post, this.publicMediaBaseUrl(), { bodyMax: 4_000 });
      },
    });
  }

  /**
   * Recent public lodge posts (not group-only). Called when Marv is asked
   * what is new, or what one member posted. Same fields as thread context.
   */
  private async listPublicPosts(rawArgs: unknown): Promise<unknown> {
    const parsed = listPublicPostsSchema.safeParse(rawArgs);
    if (!parsed.success) return { error: 'invalid_args' };
    const limit = parsed.data.limit ?? PUBLIC_POSTS_DEFAULT;
    const username = parsed.data.username;
    const scope = username ? username.toLowerCase() : 'feed';
    return await this.cache.getOrSetJson<unknown>({
      enabled: true,
      key: `marv:tool:public-posts:${scope}:${limit}`,
      ttlSeconds: TTL_PUBLIC_POSTS,
      compute: async () => {
        const userFilter = {
          user: {
            ...NOT_BANNED_USER_WHERE,
            ...(username ? { username: { equals: username, mode: 'insensitive' as const } } : {}),
          },
        };
        if (username) {
          const exists = await this.prisma.user.findFirst({
            where: { username: { equals: username, mode: 'insensitive' }, ...NOT_BANNED_USER_WHERE },
            select: { id: true },
          });
          if (!exists) return { error: 'user_not_found', posts: [], note: 'No member found with that username.' };
        }
        const rows = await this.postsRead.findMany({
          where: {
            ...NOT_DELETED,
            visibility: 'public',
            parentId: null,
            ...marvPublicProfilePostWhere(),
            ...userFilter,
          },
          orderBy: { createdAt: 'desc' },
          take: limit,
          select: marvPostSelect(),
        });
        const publicBaseUrl = this.publicMediaBaseUrl();
        const posts = rows.map((row) => compactMarvPost(row, publicBaseUrl, { bodyMax: 800 }));
        return {
          posts,
          note:
            posts.length === 0
              ? username
                ? 'That member has no recent public posts on Men of Hunger.'
                : 'No recent public posts on Men of Hunger.'
              : 'Public Men of Hunger posts only (not group-only). Use get_post for a full thread.',
        };
      },
    });
  }

  private async listPublicArticles(rawArgs: unknown): Promise<unknown> {
    const parsed = listLimitSchema.safeParse(rawArgs ?? {});
    if (!parsed.success) return { error: 'invalid_args' };
    const { articles } = await this.platform.listPublicArticles(parsed.data.limit ?? 4);
    return {
      articles,
      note: articles.length === 0 ? 'No published public articles on Men of Hunger.' : 'Published public articles on Men of Hunger.',
    };
  }

  private async listBoard(rawArgs: unknown): Promise<unknown> {
    const parsed = listLimitSchema.safeParse(rawArgs ?? {});
    if (!parsed.success) return { error: 'invalid_args' };
    const { threads } = await this.platform.listBoard(parsed.data.limit ?? 5);
    return {
      threads,
      note: threads.length === 0 ? 'Nothing recent on the public Board.' : 'Public Board threads on Men of Hunger.',
    };
  }

  private async listGroupFeed(rawArgs: unknown, ctx: MarvAIToolCallContext): Promise<unknown> {
    const parsed = listLimitSchema.safeParse(rawArgs ?? {});
    if (!parsed.success) return { error: 'invalid_args' };
    const groupId = (ctx.groupId ?? '').trim();
    if (!groupId) {
      return {
        error: 'not_in_a_group',
        posts: [],
        note: 'This conversation is not inside a group. Public Men of Hunger is in the briefing and list_public_posts.',
      };
    }
    const { posts } = await this.platform.listGroupFeed(groupId, parsed.data.limit ?? 6);
    return { posts, note: 'Feed posts in this group only.' };
  }

  private async searchGroupChannels(rawArgs: unknown, ctx: MarvAIToolCallContext): Promise<unknown> {
    const parsed = searchGroupChannelsSchema.safeParse(rawArgs);
    if (!parsed.success) return { error: 'invalid_query' };
    const groupId = (ctx.groupId ?? '').trim();
    if (!groupId) return { error: 'not_in_a_group', messages: [] };
    return this.platform.searchChannels(
      { groupId, channelId: ctx.channelId, privateChannel: ctx.privateChannel },
      parsed.data.query,
    );
  }

  private publicMediaBaseUrl(): string | null {
    return this.appConfig.r2()?.publicBaseUrl ?? null;
  }

  async getPostThreadRecentMessages(rawArgs: unknown, ctx: MarvAIToolCallContext) : Promise<unknown> {
    return this.chatContext.getPostThreadRecentMessages(rawArgs, ctx);
  }

  async getPostThreadSummary(rawArgs: unknown, ctx: MarvAIToolCallContext) : Promise<unknown> {
    return this.chatContext.getPostThreadSummary(rawArgs, ctx);
  }

  async getMyRecentChatMessages(rawArgs: unknown, ctx: MarvAIToolCallContext) : Promise<unknown> {
    return this.chatContext.getMyRecentChatMessages(rawArgs, ctx);
  }

  /**
   * Fetches the full text content of a web page via Jina Reader (r.jina.ai).
   * Results are cached in Redis for one hour so repeated references to the same URL
   * within a session don't incur extra network round-trips or credit charges.
   */
  private async fetchUrlContent(rawArgs: unknown): Promise<unknown> {
    const parsed = fetchUrlContentSchema.safeParse(rawArgs);
    if (!parsed.success) return { error: 'invalid_args' };

    const { url } = parsed.data;
    let parsedUrl: URL;
    try {
      parsedUrl = new URL(url);
    } catch {
      return { error: 'invalid_url', note: 'The provided value is not a valid URL.' };
    }
    if (parsedUrl.protocol !== 'http:' && parsedUrl.protocol !== 'https:') {
      return { error: 'invalid_url', note: 'Only http and https URLs are supported.' };
    }

    const urlHash = crypto.createHash('sha1').update(url).digest('hex').slice(0, 20);
    const cacheKey = `marv:tool:url-content:${urlHash}`;

    type ContentShape = { url: string; content: string; truncated: boolean; fetchedAt: string };

    const result = await this.cache.getOrSetNullableJson<ContentShape>({
      enabled: true,
      key: cacheKey,
      ttlSeconds: TTL_URL_CONTENT,
      nullTtlSeconds: TTL_NEGATIVE,
      compute: async () => {
        const controller = new AbortController();
        const timeout = setTimeout(() => controller.abort(), URL_FETCH_TIMEOUT_MS);
        try {
          // Jina Reader converts any web page to clean markdown — ideal for LLM consumption.
          const res = await fetch(`https://r.jina.ai/${url}`, {
            method: 'GET',
            signal: controller.signal,
            headers: { Accept: 'text/plain, text/markdown, */*' },
          });
          if (!res.ok) {
            this.logger.warn(`[marv-tools] fetch_url_content: Jina returned ${res.status} for ${url}`);
            return null;
          }
          const text = (await res.text()).trim();
          if (!text) return null;
          const truncated = text.length > MAX_URL_CONTENT_CHARS;
          return {
            url,
            content: text.slice(0, MAX_URL_CONTENT_CHARS),
            truncated,
            fetchedAt: new Date().toISOString(),
          };
        } catch (err) {
          this.logger.warn(
            `[marv-tools] fetch_url_content: fetch failed for ${url}: ${err instanceof Error ? err.message : String(err)}`,
          );
          return null;
        } finally {
          clearTimeout(timeout);
        }
      },
    });

    if (!result) {
      return { error: 'fetch_failed', note: 'Could not retrieve content for this URL. It may be unavailable, paywalled, or require JavaScript.' };
    }
    return result;
  }

  /**
   * Non-AI scripture lookup via {@link ScriptureService} (bible.helloao.org + Redis).
   * Use only when the user asks for a passage — do not volunteer Scripture.
   */
  private async getBiblePassage(rawArgs: unknown): Promise<unknown> {
    const parsed = getBiblePassageSchema.safeParse(rawArgs);
    if (!parsed.success) return { error: 'invalid_args' };
    const { reference } = parsed.data;
    const dto = await this.scripture.getRef(reference);
    if (!dto) {
      return {
        error: 'not_found',
        note: 'Could not resolve that scripture reference. Try a clearer form like "John 3:16", "Rom 9", or "Romans 8:28-30".',
      };
    }
    return {
      reference: dto.reference,
      translation: dto.translation,
      translationName: dto.translationName,
      text: dto.text.slice(0, 4_000),
      verseCount: dto.verses.length,
    };
  }

  async findMembersByName(rawArgs: unknown, ctx: MarvAIToolCallContext) : Promise<unknown> {
    return this.memberTools.findMembersByName(rawArgs, ctx);
  }

  async conversationUsernamesNearestFirst(ctx: MarvAIToolCallContext) : Promise<string[]> {
    return this.memberTools.conversationUsernamesNearestFirst(ctx);
  }

  async findSimilarMembers(rawArgs: unknown, ctx: MarvAIToolCallContext) : Promise<unknown> {
    return this.memberTools.findSimilarMembers(rawArgs, ctx);
  }
}
