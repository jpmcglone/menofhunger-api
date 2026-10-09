import { Injectable } from "@nestjs/common";
import { PrismaService } from "../../prisma/prisma.service";
import { CacheService } from "../../redis/cache.service";
import { PostsReadService } from "../../posts-read/posts-read.service";
import { NOT_BANNED_USER_WHERE } from "../../../common/prisma-selects/user.where";
import crypto from "node:crypto";
import type { MarvAIToolCallContext } from "./marvin-ai.service";
import {
  SIMILAR_MEMBERS_DEFAULT,
  SIMILAR_CANDIDATE_LIMIT,
  CARD_SNIPPET_MAX,
  findMembersByNameSchema,
  findSimilarMembersSchema,
  TTL_SIMILAR,
  TTL_NAME_SEARCH,
} from "./marvin-tool-handlers.schemas";
import {
  rankMembersByConversation,
  tokenizeForSimilarity,
} from "./marvin-tool-format";
import { NOT_DELETED } from '../../../common/prisma/where';

@Injectable()
export class MarvinMemberToolsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly cache: CacheService,
    private readonly postsRead: PostsReadService,
  ) {}

  async findMembersByName(
    rawArgs: unknown,
    ctx: MarvAIToolCallContext,
  ): Promise<unknown> {
    const parsed = findMembersByNameSchema.safeParse(rawArgs);
    if (!parsed.success) return { error: "invalid_args" };
    const name = parsed.data.name.trim();
    const limit = parsed.data.limit ?? 5;
    const key = name.toLowerCase();
    const scope =
      (ctx.rootPostId ?? ctx.conversationId ?? "none").trim() || "none";
    return await this.cache.getOrSetJson<unknown>({
      enabled: true,
      key: `marv:tool:name:${key}:${limit}:scope:${scope}`,
      ttlSeconds: TTL_NAME_SEARCH,
      compute: async () => {
        const rows = await this.prisma.user.findMany({
          where: {
            ...NOT_BANNED_USER_WHERE,
            isBot: false,
            username: { not: null },
            OR: [
              { username: { equals: name, mode: "insensitive" } },
              { name: { equals: name, mode: "insensitive" } },
              { name: { startsWith: `${name} `, mode: "insensitive" } },
              { name: { endsWith: ` ${name}`, mode: "insensitive" } },
              { username: { contains: name, mode: "insensitive" } },
              { name: { contains: name, mode: "insensitive" } },
            ],
          },
          select: { username: true, name: true },
          take: Math.max(limit, 8),
          orderBy: { createdAt: "asc" },
        });
        const here = await this.conversationUsernamesNearestFirst(ctx);
        const hereSet = new Set(here.map((u) => u.toLowerCase()));
        const members = rankMembersByConversation(
          rows
            .filter((row) => (row.username ?? "").trim())
            .map((row) => ({
              username: row.username as string,
              displayName: row.name,
            })),
          here,
        ).slice(0, limit);
        if (members.length === 0) {
          return {
            members: [],
            note: "No members matched that name. Ask for a @username.",
          };
        }
        const inConversation = members.filter((m) =>
          hereSet.has(m.username.toLowerCase()),
        );
        if (inConversation.length === 1) {
          return {
            members,
            note: `@${inConversation[0]!.username} is in this conversation — use that handle.`,
          };
        }
        if (inConversation.length > 1) {
          return {
            members,
            note: "Multiple people in this conversation match. Prefer the first (nearest).",
          };
        }
        return {
          members,
          note:
            members.length === 1
              ? "Nobody in this conversation matched. Use this @username if it is the person they meant."
              : "Nobody in this conversation matched. These are platform-wide results — do not guess.",
        };
      },
    });
  }

  async conversationUsernamesNearestFirst(
    ctx: MarvAIToolCallContext,
  ): Promise<string[]> {
    const seen = new Set<string>();
    const out: string[] = [];
    const add = (raw?: string | null) => {
      const handle = (raw ?? "").trim().replace(/^@/, "");
      if (!handle) return;
      const key = handle.toLowerCase();
      if (key === "marv" || seen.has(key)) return;
      seen.add(key);
      out.push(handle);
    };
    add(ctx.requesterUsername);
    if (ctx.rootPostId) {
      const posts = await this.postsRead.findMany({
        where: {
          ...NOT_DELETED,
          OR: [{ id: ctx.rootPostId }, { rootId: ctx.rootPostId }],
        },
        select: { user: { select: { username: true } } },
        orderBy: { createdAt: "desc" },
        take: 40,
      });
      for (const post of posts) add(post.user?.username);
    } else if (ctx.conversationId) {
      const messages = await this.prisma.message.findMany({
        where: { conversationId: ctx.conversationId, deletedForAll: false },
        select: { sender: { select: { username: true } } },
        orderBy: { createdAt: "desc" },
        take: 40,
      });
      for (const message of messages) add(message.sender?.username);
    }
    return out;
  }

  async findSimilarMembers(
    rawArgs: unknown,
    ctx: MarvAIToolCallContext,
  ): Promise<unknown> {
    const parsed = findSimilarMembersSchema.safeParse(rawArgs);
    if (!parsed.success) return { error: "invalid_args" };
    const limit = parsed.data.limit ?? SIMILAR_MEMBERS_DEFAULT;
    const query = (parsed.data.query ?? "").trim();
    const requesterUserId = ctx.requesterUserId;
    if (!requesterUserId) return { error: "missing_requester" };

    const queryHash = crypto
      .createHash("sha1")
      .update(`${requesterUserId}|${query.toLowerCase()}|${limit}`)
      .digest("hex")
      .slice(0, 16);

    return await this.cache.getOrSetJson<unknown>({
      enabled: true,
      key: `marv:tool:similar:${queryHash}`,
      ttlSeconds: TTL_SIMILAR,
      compute: async () => {
        const requester = await this.prisma.user.findUnique({
          where: { id: requesterUserId },
          select: {
            interests: true,
            contextCard: { select: { cardText: true } },
          },
        });
        if (!requester) return { error: "requester_not_found", members: [] };

        const interestSeeds = new Set(
          (requester.interests ?? [])
            .map((i) => i.trim().toLowerCase())
            .filter(Boolean),
        );
        for (const token of tokenizeForSimilarity(query)) {
          interestSeeds.add(token);
        }
        // Also seed from the requester's own card so "anyone like me?" works with no query.
        if (!query) {
          for (const token of tokenizeForSimilarity(
            requester.contextCard?.cardText ?? "",
          )) {
            interestSeeds.add(token);
          }
        }
        const seeds = [...interestSeeds].slice(0, 24);
        if (seeds.length === 0) {
          return {
            members: [],
            note: "No interests or query to match on. Ask the user what they are looking for.",
          };
        }

        // Prefer structured interest overlap (Prisma hasSome). Also pull a small
        // recent-card cohort so free-text queries can still match on cardText.
        const requesterInterests = (requester.interests ?? []).filter(Boolean);
        const byInterest =
          requesterInterests.length > 0
            ? await this.prisma.user.findMany({
                where: {
                  id: { not: requesterUserId },
                  ...NOT_BANNED_USER_WHERE,
                  isBot: false,
                  interests: { hasSome: requesterInterests },
                },
                select: {
                  username: true,
                  name: true,
                  interests: true,
                  contextCard: { select: { cardText: true } },
                },
                take: SIMILAR_CANDIDATE_LIMIT,
              })
            : [];

        const byCard =
          seeds.length > 0
            ? await this.prisma.user.findMany({
                where: {
                  id: { not: requesterUserId },
                  ...NOT_BANNED_USER_WHERE,
                  isBot: false,
                  contextCard: {
                    is: {
                      OR: seeds.slice(0, 8).map((term) => ({
                        cardText: {
                          contains: term,
                          mode: "insensitive" as const,
                        },
                      })),
                    },
                  },
                },
                select: {
                  username: true,
                  name: true,
                  interests: true,
                  contextCard: { select: { cardText: true } },
                },
                take: SIMILAR_CANDIDATE_LIMIT,
              })
            : [];

        const seen = new Set<string>();
        const merged = [...byInterest, ...byCard].filter((u) => {
          const key = (u.username ?? "").toLowerCase();
          if (!key || seen.has(key)) return false;
          seen.add(key);
          return true;
        });

        const scored = merged
          .map((row) => {
            const interestOverlap = (row.interests ?? [])
              .map((i) => i.trim().toLowerCase())
              .filter((i) => interestSeeds.has(i));
            const cardLower = (row.contextCard?.cardText ?? "").toLowerCase();
            const cardHits = seeds.filter(
              (s) => s.length >= 3 && cardLower.includes(s),
            );
            const score = interestOverlap.length * 3 + cardHits.length;
            const reasons: string[] = [];
            if (interestOverlap.length) {
              reasons.push(
                `shared interests: ${interestOverlap.slice(0, 4).join(", ")}`,
              );
            } else if (cardHits.length) {
              reasons.push(
                `profile mentions: ${cardHits.slice(0, 4).join(", ")}`,
              );
            }
            return {
              username: row.username,
              displayName: row.name,
              cardSnippet:
                (row.contextCard?.cardText ?? "").slice(0, CARD_SNIPPET_MAX) ||
                null,
              reasons,
              score,
            };
          })
          .filter((m) => m.score > 0 && m.username)
          .sort((a, b) => b.score - a.score)
          .slice(0, limit)
          .map(({ score: _s, ...rest }) => rest);

        return { members: scored, matchedOn: seeds.slice(0, 8) };
      },
    });
  }
}
