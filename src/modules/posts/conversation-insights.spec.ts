import {
  addConversationEvent,
  conversationDays,
  unansweredOpportunity,
} from "./conversation-insights";
import { ConversationsService } from "./conversations.service";

describe("Conversation insights", () => {
  it("keeps UTC buckets complete, with coins separate from reply counts", () => {
    const days = conversationDays(
      new Date("2026-08-30T00:00:00Z"),
      new Date("2026-09-05T20:00:00Z"),
    );
    expect(days).toHaveLength(7);
    addConversationEvent(
      days,
      new Date("2026-09-01T01:00:00Z"),
      "replies",
      1,
      true,
    );
    addConversationEvent(days, new Date("2026-09-01T23:59:00Z"), "coins", 500);
    addConversationEvent(days, new Date("2026-08-29T23:59:00Z"), "replies");
    expect(days[2]).toEqual({
      date: "2026-09-01",
      replies: 1,
      reposts: 0,
      coins: 500,
      branches: 1,
    });
  });

  it("deduplicates participants across posts and excludes the author and bots", async () => {
    const user = (id: string, isBot = false) => ({
      id,
      username: id,
      name: id,
      avatarKey: null,
      avatarUpdatedAt: null,
      isBot,
    });
    const event = (
      id: string,
      rootId: string,
      userId: string,
      isBot = false,
    ) => ({
      id,
      rootId,
      parentId: rootId,
      userId,
      body: "A thoughtful answer to the question.",
      createdAt: new Date("2026-09-02T12:00:00Z"),
      quotedPostId: null,
      repostedPostId: null,
      user: user(userId, isBot),
    });
    const findMany = jest
      .fn()
      .mockResolvedValueOnce([
        {
          id: "a",
          body: "New post",
          createdAt: new Date("2026-09-01T12:00:00Z"),
        },
        {
          id: "b",
          body: "Older post",
          createdAt: new Date("2026-08-01T12:00:00Z"),
        },
      ])
      .mockResolvedValueOnce([
        event("r1", "a", "friend"),
        event("r2", "b", "friend"),
        event("r3", "a", "new"),
        event("r4", "a", "owner"),
        event("r5", "a", "bot", true),
      ])
      .mockResolvedValueOnce([{ userId: "friend" }]);
    const prisma = {
      post: { findMany },
      coinTransfer: {
        findMany: jest
          .fn()
          .mockResolvedValue([
            {
              postId: "a",
              amount: 10,
              createdAt: new Date("2026-09-02T12:00:00Z"),
            },
          ]),
      },
    };
    const service = new ConversationsService(
      prisma as never,
      {} as never,
      { r2: () => null } as never,
    );
    jest.spyOn(service, "readableWhere").mockResolvedValue({ deletedAt: null });
    const result = await service.insights(
      "owner",
      undefined,
      new Date("2026-09-05T12:00:00Z"),
    );
    expect(result.participantCount).toBe(2);
    expect(result.newParticipantCount).toBe(1);
    expect(result.postCount).toBe(1);
    expect(result.renewedCount).toBe(1);
    expect(result.posts[0].participantCount).toBe(2);
    expect(result.timeline.reduce((n, d) => n + d.replies, 0)).toBe(4);
    expect(result.timeline.reduce((n, d) => n + d.coins, 0)).toBe(10);
    expect(findMany.mock.calls[2][0].where.deletedAt).toBeUndefined();
  });

  it("returns not-found when the requested root is not owned and readable", async () => {
    const findMany = jest.fn().mockResolvedValue([]);
    const service = new ConversationsService(
      { post: { findMany } } as never,
      {} as never,
      {} as never,
    );
    jest.spyOn(service, "readableWhere").mockResolvedValue({ deletedAt: null });
    await expect(service.insights("owner", "other-post")).rejects.toThrow(
      "Post not found.",
    );
    expect(findMany.mock.calls[0][0].where.AND).toContainEqual(
      expect.objectContaining({ userId: "owner", parentId: null }),
    );
  });

  it("applies audience, blocks and active group membership to analytics and previews", async () => {
    const prisma = {
      userBlock: {
        findMany: jest
          .fn()
          .mockResolvedValue([{ blockerId: "blocked", blockedId: "owner" }]),
      },
      communityGroupMember: {
        findMany: jest.fn().mockResolvedValue([{ groupId: "crew" }]),
      },
    };
    const viewers = {
      getViewerOrThrow: jest.fn().mockResolvedValue({ verifiedStatus: "none" }),
      allowedPostVisibilities: () => ["public"],
    };
    const service = new ConversationsService(
      prisma as never,
      viewers as never,
      {} as never,
    );
    const where = await service.readableWhere("owner");
    expect(JSON.stringify(where)).toContain("blocked");
    expect(JSON.stringify(where)).toContain("crew");
    expect(JSON.stringify(where)).not.toContain("premiumOnly");
    expect(JSON.stringify(where)).not.toContain("open");
    expect(prisma.communityGroupMember.findMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: { userId: "owner", status: "active" } }),
    );
  });
});

describe("Unanswered opportunities", () => {
  const now = new Date("2026-09-05T12:00:00Z").getTime();
  const post = {
    body: "How have you made time for family while starting a business?",
    parentId: null,
    kind: "regular",
    commentCount: 0,
    viewerCount: 3,
    createdAt: new Date(now - 3600000),
  };
  it("requires relevance and low exposure, not just zero replies", () => {
    expect(unansweredOpportunity(post, true, false, now)).toBe(true);
    expect(unansweredOpportunity(post, false, false, now)).toBe(false);
    expect(unansweredOpportunity(post, true, true, now)).toBe(false);
    expect(
      unansweredOpportunity({ ...post, viewerCount: 100 }, true, false, now),
    ).toBe(false);
    expect(
      unansweredOpportunity({ ...post, commentCount: 1 }, true, false, now),
    ).toBe(false);
    expect(
      unansweredOpportunity({ ...post, body: "Really?" }, true, false, now),
    ).toBe(false);
    expect(
      unansweredOpportunity(
        { ...post, createdAt: new Date(now - 3 * 86400000) },
        true,
        false,
        now,
      ),
    ).toBe(false);
  });
});
