import { Injectable, NotFoundException } from "@nestjs/common";
import { Prisma } from "@prisma/client";
import { PrismaService } from "../prisma/prisma.service";
import { ViewerContextService } from "../viewer/viewer-context.service";
import { AppConfigService } from "../app/app-config.service";
import { publicAssetUrl } from "../../common/assets/public-asset-url";
import type {
  ConversationInsightsDto,
  ConversationPersonDto,
  ConversationContextDto,
} from "../../common/dto/conversation.dto";
import {
  conversationDays,
  addConversationEvent,
  DAY_MS,
  unansweredOpportunity,
} from "./conversation-insights";
const personSelect = {
  id: true,
  username: true,
  name: true,
  avatarKey: true,
  avatarUpdatedAt: true,
} as const;
type Person = Prisma.UserGetPayload<{ select: typeof personSelect }>;

@Injectable()
export class ConversationsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly viewers: ViewerContextService,
    private readonly config: AppConfigService,
  ) {}
  private person(user: Person): ConversationPersonDto {
    return {
      id: user.id,
      username: user.username,
      name: user.name,
      avatarUrl: publicAssetUrl({
        publicBaseUrl: this.config.r2()?.publicBaseUrl,
        key: user.avatarKey,
        updatedAt: user.avatarUpdatedAt,
      }),
    };
  }
  async readableWhere(userId: string): Promise<Prisma.PostWhereInput> {
    const [viewer, blocks, memberships] = await Promise.all([
      this.viewers.getViewerOrThrow(userId),
      this.prisma.userBlock.findMany({
        where: { OR: [{ blockerId: userId }, { blockedId: userId }] },
        select: { blockerId: true, blockedId: true },
      }),
      this.prisma.communityGroupMember.findMany({
        where: { userId, status: "active" },
        select: { groupId: true },
      }),
    ]);
    const excluded = blocks.map((b) =>
      b.blockerId === userId ? b.blockedId : b.blockerId,
    );
    return {
      AND: [
        {
          deletedAt: null,
          isDraft: false,
          user: { bannedAt: null },
          userId: { notIn: excluded },
        },
        {
          OR: [
            { userId },
            {
              visibility: {
                in: this.viewers
                  .allowedPostVisibilities(viewer)
                  .filter((v) => v !== "onlyMe"),
              },
            },
          ],
        },
        {
          OR: [
            { communityGroupId: null },
            {
              communityGroup: {
                deletedAt: null,
                OR: [
                  { id: { in: memberships.map((m) => m.groupId) } },
                  ...(viewer.verifiedStatus !== "none"
                    ? [{ joinPolicy: "open" as const }]
                    : []),
                ],
              },
            },
          ],
        },
      ],
    };
  }
  async insights(
    userId: string,
    postId?: string,
    now = new Date(),
  ): Promise<ConversationInsightsDto> {
    const to = now;
    const from = new Date(
      Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()) -
        (postId ? 29 : 6) * DAY_MS,
    );
    const readable = await this.readableWhere(userId);
    const eventWhere: Prisma.PostWhereInput = {
      AND: [readable, { createdAt: { gte: from, lte: to } }],
    };
    const roots = await this.prisma.post.findMany({
      where: {
        AND: [
          readable,
          {
            userId,
            parentId: null,
            kind: { not: "repost" },
            visibility: { not: "onlyMe" },
          },
          postId
            ? { id: postId }
            : {
                OR: [
                  { createdAt: { gte: from, lte: to } },
                  { threadReplies: { some: eventWhere } },
                  { replies: { some: eventWhere } },
                  { reposts: { some: eventWhere } },
                  { quotes: { some: eventWhere } },
                  {
                    coinTransfers: {
                      some: {
                        createdAt: { gte: from, lte: to },
                        recipientId: userId,
                      },
                    },
                  },
                ],
              },
        ],
      },
      select: { id: true, body: true, createdAt: true },
      orderBy: [{ createdAt: "desc" }, { id: "desc" }],
    });
    if (postId && !roots.length) throw new NotFoundException("Post not found.");
    const ids = roots.map((p) => p.id);
    const [events, transfers] = ids.length
      ? await Promise.all([
          this.prisma.post.findMany({
            where: {
              AND: [
                eventWhere,
                {
                  OR: [
                    { rootId: { in: ids } },
                    { parentId: { in: ids } },
                    { repostedPostId: { in: ids } },
                    { quotedPostId: { in: ids } },
                  ],
                },
              ],
            },
            select: {
              id: true,
              body: true,
              createdAt: true,
              userId: true,
              parentId: true,
              rootId: true,
              repostedPostId: true,
              quotedPostId: true,
              user: { select: { ...personSelect, isBot: true } },
            },
            orderBy: [{ createdAt: "asc" }, { id: "asc" }],
          }),
          this.prisma.coinTransfer.findMany({
            where: {
              postId: { in: ids },
              recipientId: userId,
              kind: "transfer",
              createdAt: { gte: from, lte: to },
            },
            select: { postId: true, createdAt: true, amount: true },
          }),
        ])
      : [[], []];
    const posts = roots.map((root) => ({
      ...root,
      createdAt: root.createdAt.toISOString(),
      renewed: root.createdAt < from,
      participantCount: 0,
      participants: [] as ConversationPersonDto[],
      replies: [] as Array<{
        id: string;
        body: string;
        createdAt: string;
        author: ConversationPersonDto;
      }>,
      timeline: conversationDays(from, to),
    }));
    const byId = new Map(posts.map((p) => [p.id, p]));
    const participants = new Set<string>();
    const postPeople = new Map(ids.map((id) => [id, new Set<string>()]));
    for (const e of events) {
      if (e.parentId) {
        const id = e.rootId ?? e.parentId;
        const p = byId.get(id);
        if (p && !e.user.isBot) {
          addConversationEvent(
            p.timeline,
            e.createdAt,
            "replies",
            1,
            e.parentId === id,
          );
          if (e.userId !== userId) {
            participants.add(e.userId);
            const people = postPeople.get(id)!;
            if (!people.has(e.userId) && p.participants.length < 6)
              p.participants.push(this.person(e.user));
            people.add(e.userId);
            p.participantCount = people.size;
            p.replies.push({
              id: e.id,
              body: e.body.slice(0, 240),
              createdAt: e.createdAt.toISOString(),
              author: this.person(e.user),
            });
            if (p.replies.length > 3) p.replies.shift();
          }
        }
      }
      const shared = e.repostedPostId ?? e.quotedPostId;
      if (shared && byId.has(shared))
        addConversationEvent(
          byId.get(shared)!.timeline,
          e.createdAt,
          "reposts",
        );
    }
    for (const t of transfers)
      if (t.postId && byId.has(t.postId))
        addConversationEvent(
          byId.get(t.postId)!.timeline,
          t.createdAt,
          "coins",
          t.amount,
        );
    // Include soft-deleted historical replies: deleting a reply must not make someone "new" again.
    const prior = participants.size
      ? await this.prisma.post.findMany({
          where: {
            userId: { in: [...participants] },
            parentId: { not: null },
            createdAt: { lt: from },
            OR: [{ parent: { userId } }, { root: { userId } }],
          },
          select: { userId: true },
          distinct: ["userId"],
        })
      : [];
    const timeline = conversationDays(from, to);
    for (const p of posts)
      p.timeline.forEach((d, i) => {
        for (const k of ["replies", "reposts", "coins", "branches"] as const)
          timeline[i][k] += d[k];
      });
    return {
      from: from.toISOString(),
      to: to.toISOString(),
      postCount: posts.filter((p) => !p.renewed).length,
      renewedCount: posts.filter((p) => p.renewed).length,
      participantCount: participants.size,
      newParticipantCount: participants.size - prior.length,
      timeline,
      posts,
    };
  }

  /** Bounded, viewer-scoped signals; coin transfers are deliberately absent. */
  async contexts(
    userId: string,
    ids: string[],
  ): Promise<Map<string, ConversationContextDto>> {
    if (!ids.length) return new Map();
    const readable = await this.readableWhere(userId);
    const since = new Date(Date.now() - 7 * DAY_MS);
    const [posts, views, follows, participation, topicFollows] =
      await Promise.all([
        this.prisma.post.findMany({
          where: { AND: [readable, { id: { in: ids } }] },
          select: {
            id: true,
            body: true,
            parentId: true,
            kind: true,
            commentCount: true,
            viewerCount: true,
            createdAt: true,
            userId: true,
            quotedPostId: true,
            topics: true,
          },
        }),
        this.prisma.postView.findMany({
          where: { userId, postId: { in: ids } },
          select: { postId: true, lastSeenAt: true },
        }),
        this.prisma.follow.findMany({
          where: { followerId: userId },
          select: { followingId: true },
        }),
        this.prisma.post.findMany({
          where: {
            userId,
            deletedAt: null,
            OR: [{ rootId: { in: ids } }, { parentId: { in: ids } }],
          },
          select: { rootId: true, parentId: true },
          distinct: ["rootId", "parentId"],
        }),
        this.prisma.topicFollow.findMany({
          where: { userId },
          select: { topic: true },
        }),
      ]);
    const seen = new Map(views.map((v) => [v.postId, v.lastSeenAt]));
    const followed = new Set(follows.map((f) => f.followingId));
    const topics = new Set(topicFollows.map((t) => t.topic));
    const participated = new Set(
      participation.flatMap((p) =>
        [p.rootId, p.parentId].filter((id): id is string => !!id),
      ),
    );
    const replies = await this.prisma.post.findMany({
      where: {
        AND: [
          readable,
          {
            parentId: { in: ids },
            createdAt: { gte: since },
            userId: { not: userId },
            user: { isBot: false },
            body: { not: "" },
          },
        ],
      },
      select: {
        id: true,
        body: true,
        parentId: true,
        createdAt: true,
        userId: true,
        user: { select: personSelect },
      },
      orderBy: [{ createdAt: "desc" }, { id: "desc" }],
      take: 240,
    });
    const out = new Map<string, ConversationContextDto>();
    for (const p of posts) {
      const lastSeen = seen.get(p.id);
      const reply = replies.find(
        (r) =>
          r.parentId === p.id &&
          r.body.trim().length >= 40 &&
          (participated.has(p.id) ||
            followed.has(r.userId) ||
            r.userId === p.userId) &&
          (!lastSeen || r.createdAt > lastSeen),
      );
      if (
        reply &&
        (!lastSeen || Date.now() - lastSeen.getTime() > 6 * 60 * 60 * 1000)
      ) {
        out.set(p.id, {
          kind: "newReplies",
          relatedPostId: null,
          reply: {
            id: reply.id,
            body: reply.body.slice(0, 240),
            createdAt: reply.createdAt.toISOString(),
            author: this.person(reply.user),
          },
        });
      } else if (
        unansweredOpportunity(
          p,
          followed.has(p.userId) || p.topics.some((t) => topics.has(t)),
          !!lastSeen,
          Date.now(),
        )
      ) {
        out.set(p.id, { kind: "unanswered", reply: null, relatedPostId: null });
      }
    }
    // A self-quote is an explicit linked follow-up, using the existing quote composer.
    const quotedIds = posts
      .map((p) => p.quotedPostId)
      .filter((id): id is string => !!id);
    if (quotedIds.length) {
      const originals = await this.prisma.post.findMany({
        where: {
          AND: [
            readable,
            {
              id: { in: quotedIds },
              OR: [
                { userId: { in: [...followed] } },
                { boosts: { some: { userId } } },
                { bookmarks: { some: { userId } } },
                { replies: { some: { userId, deletedAt: null } } },
                { threadReplies: { some: { userId, deletedAt: null } } },
              ],
            },
          ],
        },
        select: { id: true, userId: true },
      });
      for (const p of posts)
        if (
          originals.some(
            (o) => o.id === p.quotedPostId && o.userId === p.userId,
          )
        )
          out.set(p.id, {
            kind: "followUp",
            reply: null,
            relatedPostId: p.quotedPostId,
          });
    }
    return out;
  }
}
