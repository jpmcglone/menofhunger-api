import { Prisma } from "@prisma/client";
import { PostsBoardWritePolicy } from "./posts-board-write.policy";
import { PostsCheckinWriteService } from "./posts-checkin-write.service";
import { PostsQuoteWriteService } from "./posts-quote-write.service";
import { PostsWriteAuthorizationService } from "./posts-write-authorization.service";
import type { CreatePostParams } from "./posts-mutation.types";

const now = new Date("2026-10-08T22:00:00Z");
const params: CreatePostParams = {
  userId: "author",
  body: "Hello",
  visibility: "public",
  media: null,
  poll: null,
};
const support = {
  parseMentionsFromBody: (body: string) =>
    body.includes("@marv") ? ["marv"] : [],
};
const config = { marvBot: () => ({ userId: "marv", username: "marv" }) };
function authorization(
  options: {
    verified?: boolean;
    groupMember?: boolean;
    blocked?: boolean;
    banned?: boolean;
  } = {},
) {
  const actor = {
    id: "author",
    verifiedStatus: options.verified === false ? "none" : "identity",
    premium: false,
    premiumPlus: false,
    isBot: false,
    bannedAt: options.banned ? now : null,
  };
  const parent = {
    id: "parent",
    userId: "other",
    visibility: "public",
    rootId: null,
    communityGroupId: null,
    topics: [],
    kind: "regular",
    articleId: null,
    body: "",
    mentions: [],
    user: { isBot: false },
  };
  const prisma = {
    post: {
      findFirst: jest.fn(async () => parent),
      findMany: jest.fn(async () => []),
    },
    userBlock: { count: jest.fn(async () => (options.blocked ? 1 : 0)) },
    communityGroupMember: {
      findUnique: jest.fn(async () =>
        options.groupMember ? { status: "active" } : null,
      ),
    },
  };
  const viewer = {
    getViewer: jest.fn(async () => actor),
    assertNotBanned: (value: typeof actor) => {
      if (value.bannedAt) throw new Error("account_banned");
    },
  };
  const enrichment = {
    allowedVisibilitiesForViewer: () =>
      options.verified === false ? ["public"] : ["public", "verifiedOnly"],
  };
  const site = {
    get: jest.fn(async () => ({
      verifiedPostsPerWindow: 10,
      verifiedWindowSeconds: 60,
    })),
  };
  const board = new PostsBoardWritePolicy(config as never, support as never);
  const service = new PostsWriteAuthorizationService(
    prisma as never,
    config as never,
    viewer as never,
    enrichment as never,
    site as never,
    support as never,
    board,
    new PostsCheckinWriteService(),
  );
  return { service, prisma, site };
}

describe("post publication authorization boundaries", () => {
  it("rejects an unverified public root before any membership or budget query", async () => {
    const { service, prisma, site } = authorization({ verified: false });
    await expect(service.authorize(params, now)).rejects.toThrow(
      "Verify your account",
    );
    expect(prisma.communityGroupMember.findUnique).not.toHaveBeenCalled();
    expect(site.get).not.toHaveBeenCalled();
  });

  it("rejects banned actors and blocked replies", async () => {
    await expect(
      authorization({ banned: true }).service.authorize(params, now),
    ).rejects.toThrow("account_banned");
    await expect(
      authorization({ blocked: true }).service.authorize(
        { ...params, parentId: "parent" },
        now,
      ),
    ).rejects.toThrow("You cannot reply");
  });

  it("forces active group members into the group audience, and rejects nonmembers", async () => {
    const groupPost = {
      ...params,
      communityGroupId: "group",
      visibility: "premiumOnly" as const,
    };
    await expect(
      authorization({ groupMember: true }).service.authorize(groupPost, now),
    ).resolves.toMatchObject({
      resolvedCommunityGroupId: "group",
      visibility: "verifiedOnly",
    });
    await expect(
      authorization().service.authorize(groupPost, now),
    ).rejects.toThrow("Join this group");
  });
});

describe("Board write policy across generic endpoints", () => {
  const policy = new PostsBoardWritePolicy(config as never, support as never);
  const parent = {
    kind: "board",
    rootId: "root",
    articleId: null,
    body: "@marv",
    mentions: [{ userId: "marv" }],
  };
  it("makes generic replies Board-only comments", () => {
    expect(policy.resolve({ ...params, parentId: "parent" }, parent)).toEqual({
      kind: "board",
      boardOnly: true,
    });
  });
  it("requires both current explicit text and persisted Marv mention", () => {
    expect(() =>
      policy.resolve(
        { ...params, userId: "marv", parentId: "parent" },
        { ...parent, mentions: [] },
        "author",
      ),
    ).toThrow("no longer mentions Marv");
    expect(() =>
      policy.resolve(
        { ...params, userId: "marv", parentId: "parent" },
        { ...parent, body: "" },
        "author",
      ),
    ).toThrow("no longer mentions Marv");
  });
  it("routes article mirror comments to the article", () => {
    expect(() =>
      policy.resolve(
        { ...params, parentId: "parent" },
        { ...parent, rootId: null, articleId: "article" },
      ),
    ).toThrow("Comment on the article");
  });
});

describe("quote publication policy inside the transaction", () => {
  const quoteSupport = {
    extractQuotedPostIdFromBody: () => "quoted",
    visibilityRank: (visibility: string) =>
      ["public", "verifiedOnly", "premiumOnly", "onlyMe"].indexOf(visibility),
  };
  const quotes = new PostsQuoteWriteService(quoteSupport as never);
  const quote = {
    id: "quoted",
    userId: "other",
    visibility: "premiumOnly",
    communityGroupId: null,
  };
  it("reads active quote metadata from the supplied tx and rejects a broader audience", async () => {
    const tx = { post: { findFirst: jest.fn(async () => quote) } };
    await expect(
      quotes.resolve(tx as never, {
        body: "link",
        visibility: "public",
        communityGroupId: null,
      }),
    ).rejects.toThrow("A quote can't be more public");
    expect(tx.post.findFirst).toHaveBeenCalledWith({
      where: { id: "quoted", deletedAt: null },
      select: {
        id: true,
        userId: true,
        visibility: true,
        communityGroupId: true,
      },
    });
  });
  it("allows a same-group quote and ignores deleted or missing sources", async () => {
    const findFirst = jest
      .fn()
      .mockResolvedValueOnce({ ...quote, communityGroupId: "group" })
      .mockResolvedValueOnce(null);
    const tx = { post: { findFirst } };
    await expect(
      quotes.resolve(tx as never, {
        body: "link",
        visibility: "verifiedOnly",
        communityGroupId: "group",
      }),
    ).resolves.toMatchObject({ id: "quoted" });
    await expect(
      quotes.resolve(tx as never, {
        body: "link",
        visibility: "public",
        communityGroupId: null,
      }),
    ).resolves.toBeNull();
  });
});

describe("checkin atomic reward ownership", () => {
  const checkins = new PostsCheckinWriteService();
  function transaction(claimCount: number, lastDay = "2026-10-07") {
    return {
      user: {
        findUnique: jest.fn(async () => ({
          checkinStreakDays: 7,
          longestStreakDays: 7,
          lastCheckinDayKey: lastDay,
        })),
        updateMany: jest.fn(async () => ({ count: claimCount })),
      },
      coinTransfer: { create: jest.fn(async () => ({})) },
    };
  }
  it("awards exactly the claimed day and records wallet history through the same tx", async () => {
    const tx = transaction(1);
    await expect(checkins.award(tx as never, "author", now)).resolves.toEqual({
      coinsEarned: 2,
      streakDays: 8,
      multiplier: 2,
    });
    expect(tx.user.updateMany).toHaveBeenCalledWith({
      where: { id: "author", lastCheckinDayKey: "2026-10-07" },
      data: {
        lastCheckinDayKey: "2026-10-08",
        checkinStreakDays: 8,
        longestStreakDays: 8,
        coins: { increment: 2 },
      },
    });
    expect(tx.coinTransfer.create).toHaveBeenCalledWith({
      data: {
        senderId: "author",
        recipientId: "author",
        kind: "streak_reward",
        amount: 2,
        note: "Day 8 streak (2x)",
      },
    });
  });
  it("does not mint coins after a competing claim or a previously awarded day", async () => {
    for (const tx of [transaction(0), transaction(1, "2026-10-08")]) {
      await expect(
        checkins.award(tx as never, "author", now),
      ).resolves.toBeNull();
      expect(tx.coinTransfer.create).not.toHaveBeenCalled();
    }
  });
  it("preserves checkin-only error mapping and propagates other failures", () => {
    const duplicate = new Prisma.PrismaClientKnownRequestError("duplicate", {
      code: "P2002",
      clientVersion: "test",
    });
    expect(() => checkins.rethrowPublicationError(duplicate, now)).toThrow(
      "Already checked in today",
    );
    const failure = new Error("database offline");
    expect(() => checkins.rethrowPublicationError(failure, now)).toThrow(
      failure,
    );
    expect(() =>
      checkins.validate(
        {
          visibility: "verifiedOnly",
          communityGroupId: null,
          dayKey: "2026-10-08",
          prompt: "Prompt",
        },
        new Date("2026-10-08T14:00:00Z"),
      ),
    ).toThrow("Check-ins open at 5pm");
  });
});
