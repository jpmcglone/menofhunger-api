import {
  addConversationEvent,
  conversationDays,
  unansweredOpportunity,
  uniqueReachPeople,
} from "./conversation-insights";
import { ConversationsService } from "./conversations.service";

describe("Conversation insights", () => {
  it("keeps Eastern day buckets complete, with coins separate from reply counts", () => {
    const days = conversationDays([
      "2026-08-30",
      "2026-08-31",
      "2026-09-01",
      "2026-09-02",
      "2026-09-03",
      "2026-09-04",
      "2026-09-05",
    ]);
    expect(days).toHaveLength(7);
    addConversationEvent(
      days,
      new Date("2026-09-01T12:00:00Z"),
      "replies",
      1,
      true,
    );
    addConversationEvent(days, new Date("2026-09-01T23:59:00Z"), "coins", 500);
    addConversationEvent(days, new Date("2026-09-01T01:00:00Z"), "replies");
    addConversationEvent(days, new Date("2026-08-29T23:59:00Z"), "replies");
    expect(days[1]).toEqual({
      date: "2026-08-31",
      replies: 1,
      reposts: 0,
      boosts: 0,
      coins: 0,
      branches: 0,
    });
    expect(days[2]).toEqual({
      date: "2026-09-01",
      replies: 1,
      reposts: 0,
      boosts: 0,
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
          totalViewCount: 42,
          createdAt: new Date("2026-09-01T12:00:00Z"),
        },
        {
          id: "b",
          body: "Older post",
          totalViewCount: 58,
          createdAt: new Date("2026-08-01T12:00:00Z"),
        },
      ])
      .mockResolvedValueOnce([
        event("r1", "a", "friend"),
        event("r2", "b", "friend"),
        event("r3", "a", "new"),
        event("r4", "a", "owner"),
        event("r5", "a", "bot", true),
        {
          ...event("s1", "a", "reposter"),
          parentId: null,
          repostedPostId: "a",
        },
        { ...event("s2", "a", "friend"), parentId: null, quotedPostId: "a" },
        {
          ...event("s3", "a", "bot", true),
          parentId: null,
          repostedPostId: "a",
        },
      ])
      .mockResolvedValueOnce([{ userId: "friend" }]);
    const postView = {
      findMany: jest.fn().mockResolvedValue([
        { userId: "friend" },
        { userId: "new" },
        { userId: "owner" },
      ]),
    };
    const postAnonView = {
      findMany: jest.fn().mockResolvedValue([{ anonId: "guest-1" }]),
    };
    const viewerIdentity = {
      findMany: jest.fn().mockResolvedValue([{ anonId: "guest-1", userId: "friend" }]),
    };
    const prisma = {
      post: { findMany },
      postView,
      postAnonView,
      viewerIdentity,
      boost: {
        findMany: jest
          .fn()
          .mockResolvedValueOnce([
            {
              postId: "a",
              createdAt: new Date("2026-09-02T12:00:00Z"),
              user: user("booster"),
            },
            {
              postId: "b",
              createdAt: new Date("2026-09-02T12:00:00Z"),
              user: user("friend"),
            },
          ])
          .mockResolvedValueOnce([{ userId: "friend" }, { userId: "booster" }]),
      },
      coinTransfer: {
        findMany: jest.fn().mockResolvedValue([
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
    expect(result.from).toBe("2026-08-30T04:00:00.000Z");
    expect(result.timeline).toHaveLength(7);
    expect(result.timeline[0]?.date).toBe("2026-08-30");
    expect(result.timeline[6]?.date).toBe("2026-09-05");
    expect(result.participantCount).toBe(4);
    expect(result.newParticipantCount).toBe(2);
    expect(result.postCount).toBe(1);
    expect(result.renewedCount).toBe(1);
    expect(result.posts[0].participantCount).toBe(4);
    expect(result.timeline.reduce((n, d) => n + d.replies, 0)).toBe(4);
    expect(result.timeline.reduce((n, d) => n + d.coins, 0)).toBe(10);
    expect(findMany.mock.calls[2][0].where.deletedAt).toBeUndefined();
    expect(result.timeline.reduce((n, d) => n + d.boosts, 0)).toBe(2);
    expect(result.timeline.reduce((n, d) => n + d.reposts, 0)).toBe(2);
    expect(result.reach).toEqual({
      people: 3,
      impressions: 100,
      scope: "lifetime",
    });
    expect(result.posts[0]).not.toHaveProperty("totalViewCount");
    expect(postView.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { postId: { in: ["a", "b"] } },
        distinct: ["userId"],
      }),
    );
    expect(postAnonView.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { postId: { in: ["a", "b"] } },
        distinct: ["anonId"],
      }),
    );
    expect(viewerIdentity.findMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: { anonId: { in: ["guest-1"] } } }),
    );
    expect(prisma.boost.findMany.mock.calls[0][0].where).toMatchObject({
      userId: { not: "owner" },
      user: {
        isBot: false,
        bannedAt: null,
        blocksInitiated: { none: { blockedId: "owner" } },
        blocksReceived: { none: { blockerId: "owner" } },
      },
    });
    expect(findMany.mock.calls[0][0].where.AND[2].OR).toContainEqual({
      boosts: {
        some: {
          createdAt: { gte: new Date(result.from), lte: new Date(result.to) },
        },
      },
    });
  });

  it("returns zero reach without querying viewer identities for an empty recap", async () => {
    const postView = { findMany: jest.fn() };
    const service = new ConversationsService(
      {
        post: { findMany: jest.fn().mockResolvedValue([]) },
        postView,
      } as never,
      {} as never,
      {} as never,
    );
    jest.spyOn(service, "readableWhere").mockResolvedValue({ deletedAt: null });
    const result = await service.insights("owner");
    expect(result.reach).toEqual({
      people: 0,
      impressions: 0,
      scope: "lifetime",
    });
    expect(result.participantCount).toBe(0);
    expect(postView.findMany).not.toHaveBeenCalled();
  });

  it("windows the recap to the last 7 Eastern days after UTC has rolled over", async () => {
    const service = new ConversationsService(
      {
        post: { findMany: jest.fn().mockResolvedValue([]) },
        $queryRaw: jest.fn(),
      } as never,
      {} as never,
      {} as never,
    );
    jest.spyOn(service, "readableWhere").mockResolvedValue({ deletedAt: null });
    const result = await service.insights(
      "owner",
      undefined,
      new Date("2026-08-30T01:20:00.000Z"),
    );
    expect(result.from).toBe("2026-08-23T04:00:00.000Z");
    expect(result.timeline).toHaveLength(7);
    expect(result.timeline[0]?.date).toBe("2026-08-23");
    expect(result.timeline[6]?.date).toBe("2026-08-29");
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

describe("Unique reach across posts", () => {
  it("counts a person once even when they viewed every recap post", () => {
    expect(
      uniqueReachPeople({
        userIds: ["friend", "friend", "owner"],
        anonIds: ["guest-1", "guest-1"],
        links: [{ anonId: "guest-1", userId: "friend" }],
      }),
    ).toBe(2);
  });

  it("keeps unlinked guests separate and does not sum per-post identities", () => {
    expect(
      uniqueReachPeople({
        userIds: ["a", "b"],
        anonIds: ["g1", "g2"],
        links: [],
      }),
    ).toBe(4);
    expect(
      uniqueReachPeople({
        userIds: ["a"],
        anonIds: ["g1"],
        links: [{ anonId: "g1", userId: "a" }],
      }),
    ).toBe(1);
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
