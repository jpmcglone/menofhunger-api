import { Injectable } from '@nestjs/common';
import type { Prisma } from '@prisma/client';
import { findGroupMemberStatus } from '../../viewer/group-membership.queries';
import { marvToolGroupAccessOr } from './marvin-post-access';
import { CacheService } from '../../redis/cache.service';
import { MarvinBotIdentityService } from './marvin-bot-identity.service';
import { PostsReadService } from '../../posts-read/posts-read.service';
import { PrismaService } from '../../prisma/prisma.service';
import type { MarvAIToolCallContext } from "./marvin-ai.service";
import {
  RECENT_MESSAGES_DEFAULT,
  RECENT_MESSAGES_MAX,
  getPostThreadRecentMessagesSchema,
  getPostThreadSummarySchema,
  getMyRecentChatMessagesSchema,
  TTL_THREAD_RECENT,
  TTL_THREAD_SUMMARY,
  TTL_CHAT_RECENT,
  TTL_NEGATIVE,
} from "./marvin-tool-handlers.schemas";
import { compactPoll } from "./marvin-tool-format";
import { NOT_DELETED } from '../../../common/prisma/where';

@Injectable()
export class MarvinChatContextToolsService {
  constructor(
    private readonly cache: CacheService,
    private readonly identity: MarvinBotIdentityService,
    private readonly postsRead: PostsReadService,
    private readonly prisma: PrismaService,
  ) {}

  async getPostThreadRecentMessages(rawArgs: unknown,
    ctx: MarvAIToolCallContext,
  ): Promise<unknown> {
    const parsed = getPostThreadRecentMessagesSchema.safeParse(rawArgs);
    if (!parsed.success) return { error: "invalid_args" };
    const requestedRoot = parsed.data.rootPostId;
    if (ctx.rootPostId && requestedRoot !== ctx.rootPostId) {
      // Don't let the model pivot to a different thread mid-call.
      return { error: "thread_not_in_scope" };
    }
    const limit = Math.min(
      RECENT_MESSAGES_MAX,
      parsed.data.limit ?? RECENT_MESSAGES_DEFAULT,
    );
    const scope = (ctx.rootPostId ?? "").trim() || "-";
    return await this.cache.getOrSetJson<unknown>({
      enabled: false,
      key: `marv:tool:thread-recent:${requestedRoot}:${limit}:root:${scope}`,
      ttlSeconds: TTL_THREAD_RECENT,
      compute: async () => {
        const root = await this.postsRead.findFirst({
          where: {
            id: requestedRoot,
            ...(await this.permittedPostWhere(ctx)),
          },
          select: {
            id: true,
            body: true,
            createdAt: true,
            user: { select: { username: true, name: true, isBot: true } },
            media: {
              where: NOT_DELETED,
              select: { kind: true },
              orderBy: { position: "asc" },
              take: 8,
            },
            poll: {
              select: {
                totalVoteCount: true,
                options: {
                  select: { text: true, voteCount: true },
                  orderBy: { position: "asc" },
                },
              },
            },
          },
        });
        if (!root) return { error: "thread_not_found" };
        const replies = await this.postsRead.findMany({
          where: {
            rootId: requestedRoot,
            ...(await this.permittedPostWhere(ctx)),
          },
          select: {
            id: true,
            body: true,
            createdAt: true,
            parentId: true,
            user: { select: { username: true, name: true, isBot: true } },
            media: {
              where: NOT_DELETED,
              select: { kind: true },
              orderBy: { position: "asc" },
              take: 8,
            },
            poll: {
              select: {
                totalVoteCount: true,
                options: {
                  select: { text: true, voteCount: true },
                  orderBy: { position: "asc" },
                },
              },
            },
          },
          orderBy: [{ createdAt: "desc" }],
          take: limit,
        });
        // Return oldest → newest for natural reading order.
        const orderedReplies = replies.slice().reverse();
        return {
          root: {
            id: root.id,
            body: (root.body ?? "").slice(0, 1_500),
            createdAt: root.createdAt.toISOString(),
            author: {
              username: root.user.username,
              displayName: root.user.name,
              isBot: root.user.isBot,
            },
            media: (root.media ?? []).map((m) => m.kind),
            poll: compactPoll(root.poll),
          },
          replies: orderedReplies.map((p) => ({
            id: p.id,
            body: (p.body ?? "").slice(0, 600),
            createdAt: p.createdAt.toISOString(),
            parentId: p.parentId,
            author: {
              username: p.user.username,
              displayName: p.user.name,
              isBot: p.user.isBot,
            },
            media: (p.media ?? []).map((m) => m.kind),
            poll: compactPoll(p.poll),
          })),
        };
      },
    });
  }

  async getPostThreadSummary(rawArgs: unknown,
    ctx: MarvAIToolCallContext,
  ): Promise<unknown> {
    const parsed = getPostThreadSummarySchema.safeParse(rawArgs);
    if (!parsed.success) return { error: "invalid_args" };
    if (ctx.rootPostId && parsed.data.rootPostId !== ctx.rootPostId) {
      return { error: "thread_not_in_scope" };
    }
    const rootPostId = parsed.data.rootPostId;
    const scope = (ctx.rootPostId ?? "").trim() || "-";
    const result = await this.cache.getOrSetNullableJson<{
      rootPostId: string;
      summary: string;
      lastMessageIdIncluded: string | null;
      updatedAt: string;
    }>({
      enabled: false,
      key: `marv:tool:thread-summary:${rootPostId}:root:${scope}`,
      ttlSeconds: TTL_THREAD_SUMMARY,
      nullTtlSeconds: TTL_NEGATIVE,
      compute: async () => {
        const root = await this.postsRead.findFirst({
          where: {
            id: rootPostId,
            ...(await this.permittedPostWhere(ctx)),
          },
          select: { id: true },
        });
        if (!root) return null;
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
    if (!result)
      return {
        error: "no_summary",
        note: "Thread is short enough that no rolling summary exists yet.",
      };
    return result;
  }

  async getMyRecentChatMessages(rawArgs: unknown,
    ctx: MarvAIToolCallContext,
  ): Promise<unknown> {
    const parsed = getMyRecentChatMessagesSchema.safeParse(rawArgs);
    if (!parsed.success) return { error: "invalid_args" };
    if (!ctx.conversationId) return { error: "no_conversation" };
    const limit = Math.min(
      RECENT_MESSAGES_MAX,
      parsed.data.limit ?? RECENT_MESSAGES_DEFAULT,
    );
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
            OR: [
              { senderId: requesterUserId },
              ...(marvId ? [{ senderId: marvId }] : []),
            ],
          },
          select: {
            id: true,
            body: true,
            createdAt: true,
            senderId: true,
            sender: { select: { username: true, name: true, isBot: true } },
          },
          orderBy: [{ createdAt: "desc" }],
          take: limit,
        });
        const ordered = messages.slice().reverse();
        return {
          conversationId,
          messages: ordered.map((m) => ({
            id: m.id,
            body: (m.body ?? "").slice(0, 1_000),
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

  async permittedPostWhere(ctx: MarvAIToolCallContext): Promise<Prisma.PostWhereInput> {
    const viewer = await this.prisma.user.findUnique({ where: { id: ctx.requesterUserId }, select: { verifiedStatus: true, premium: true, premiumPlus: true, siteAdmin: true } });
    const visibility: Array<'public' | 'verifiedOnly' | 'premiumOnly'> = ['public'];
    if (viewer && viewer.verifiedStatus !== 'none') visibility.push('verifiedOnly');
    if (viewer?.premium || viewer?.premiumPlus) visibility.push('premiumOnly');
    const root = ctx.rootPostId ? await this.postsRead.findUnique({ where: { id: ctx.rootPostId }, select: { communityGroupId: true } }) : null;
    const member = root?.communityGroupId ? await findGroupMemberStatus(this.prisma, root.communityGroupId, ctx.requesterUserId) : null;
    const permittedGroupId = member?.status === 'active' || viewer?.siteAdmin ? root?.communityGroupId : null;
    return { ...NOT_DELETED, visibility: { in: visibility }, OR: marvToolGroupAccessOr(ctx.rootPostId, permittedGroupId) };
  }
}



