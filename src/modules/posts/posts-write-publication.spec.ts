import type { Prisma } from "@prisma/client";
import { PostsMutationWriteService } from "./posts-mutation-write.service";
import { PostsCheckinWriteService } from "./posts-checkin-write.service";
import { PostsQuoteWriteService } from "./posts-quote-write.service";
import { PostsWritePersistenceService } from "./posts-write-persistence.service";
import type { CreatePostParams } from "./posts-mutation.types";

const now = new Date("2026-10-08T22:00:00Z");
const normalPost: CreatePostParams = {
  userId: "author",
  body: "A post",
  visibility: "verifiedOnly",
  media: null,
  poll: null,
};

/** Models transaction acknowledgement and rollback, without touching a database or real effects. */
function fixture(
  options: {
    failReward?: boolean;
    waitCommit?: boolean;
    scheduledClaim?: number;
    quote?: boolean;
  } = {},
) {
  const events: string[] = [];
  const state = { posts: [] as string[], walletWrites: 0, viewWrites: 0 };
  let acknowledgeCommit = () => {};
  let preparationFinished = () => {};
  const commitGate = new Promise<void>((resolve) => {
    acknowledgeCommit = resolve;
  });
  const prepared = new Promise<void>((resolve) => {
    preparationFinished = resolve;
  });
  const tx = {
    post: {
      create: jest.fn(
        async ({ data }: { data: Prisma.PostUncheckedCreateInput }) => {
          state.posts.push("published");
          return {
            ...data,
            id: "published",
            viewerCount: 0,
            totalViewCount: 0,
            weightedViewCount: 0,
          };
        },
      ),
      findFirst: jest.fn(async () =>
        options.quote
          ? {
              id: "quoted",
              userId: "other",
              visibility: "verifiedOnly",
              communityGroupId: null,
            }
          : null,
      ),
      update: jest.fn(async () => ({
        viewerCount: 1,
        totalViewCount: 1,
        weightedViewCount: 1,
        commentCount: 4,
      })),
      updateMany: jest.fn(async () => ({ count: options.scheduledClaim ?? 1 })),
    },
    postView: {
      createMany: jest.fn(async () => {
        state.viewWrites += 1;
        return { count: 1 };
      }),
    },
    user: {
      findUnique: jest.fn(async () => ({
        lastCheckinDayKey: "2026-10-07",
        checkinStreakDays: 7,
        longestStreakDays: 7,
      })),
      updateMany: jest.fn(async () => {
        state.walletWrites += 1;
        return { count: 1 };
      }),
    },
    coinTransfer: {
      create: jest.fn(async () => {
        if (options.failReward) throw new Error("reward write failed");
        return {};
      }),
    },
    hashtag: { upsert: jest.fn(async () => ({})) },
    hashtagVariant: { upsert: jest.fn(async () => ({})) },
  };
  const prisma = {
    $transaction: jest.fn(
      async (
        callback: (client: Prisma.TransactionClient) => Promise<unknown>,
      ) => {
        try {
          const result = await callback(tx as never);
          events.push("prepared");
          preparationFinished();
          if (options.waitCommit) await commitGate;
          events.push("committed");
          return result;
        } catch (error) {
          state.posts = [];
          state.walletWrites = 0;
          state.viewWrites = 0;
          events.push("rolled_back");
          throw error;
        }
      },
    ),
    post: { count: jest.fn() },
  };
  const support = {
    parseMentionsFromBody: () => [],
    resolveMentionUsernamesMap: async () => new Map<string, string>(),
    parseHashtagsFromBody: () => [],
    parseCashtagsFromBody: () => [],
    postLinksCreate: () => undefined,
    extractQuotedPostIdFromBody: () => (options.quote ? "quoted" : null),
    visibilityRank: (visibility: string) =>
      ["public", "verifiedOnly", "premiumOnly", "onlyMe"].indexOf(visibility),
  };
  const authorization = {
    authorize: jest.fn(async (params: CreatePostParams) => ({
      kind: params.kind ?? "regular",
      boardOnly: params.kind === "board",
      visibility: params.visibility,
      resolvedCommunityGroupId: null,
      threadParticipantIds: [],
      parentAuthorUserId: params.parentId ? "other" : null,
      threadRootId: params.parentId ? "root" : null,
      parentTopics: [],
      rootTopics: [],
      rateLimitParams: null,
      checkinDayKey: params.checkinDayKey ?? null,
      checkinPrompt: params.checkinPrompt ?? null,
      parentIsBot: false,
      authorIsBot: false,
      authorVerifiedStatus: "identity",
    })),
    assertRateLimit: jest.fn(async () => undefined),
  };
  const config = { marvBot: () => ({ userId: null, username: "marv" }) };
  const checkins = new PostsCheckinWriteService();
  const quotes = new PostsQuoteWriteService(support as never);
  const persistence = new PostsWritePersistenceService(
    prisma as never,
    quotes,
    checkins,
  );
  const afterCommit = {
    run: jest.fn(() => {
      events.push("after_commit");
    }),
  };
  const service = new PostsMutationWriteService(
    prisma as never,
    config as never,
    support as never,
    authorization as never,
    persistence,
    afterCommit as never,
  );
  return {
    service,
    tx,
    prisma,
    state,
    events,
    afterCommit,
    authorization,
    checkins,
    quotes,
    acknowledgeCommit,
    prepared,
  };
}

describe("post publication transaction boundary", () => {
  beforeEach(() => jest.useFakeTimers().setSystemTime(now));
  afterEach(() => jest.useRealTimers());

  it("does not open a transaction or emit effects after authorization rejection", async () => {
    const f = fixture();
    f.authorization.authorize.mockRejectedValueOnce(
      new Error("Forbidden audience"),
    );
    await expect(f.service.createPost(normalPost)).rejects.toThrow(
      "Forbidden audience",
    );
    expect(f.prisma.$transaction).not.toHaveBeenCalled();
    expect(f.afterCommit.run).not.toHaveBeenCalled();
  });

  it("waits for transaction acknowledgement before afterCommit and exposes committed self-view counts", async () => {
    const f = fixture({ waitCommit: true });
    const publishing = f.service.createPost(normalPost);
    await f.prepared;
    expect(f.afterCommit.run).not.toHaveBeenCalled();
    f.acknowledgeCommit();
    await expect(publishing).resolves.toMatchObject({
      post: { id: "published", viewerCount: 1, totalViewCount: 1 },
      streakReward: null,
    });
    expect(f.events).toEqual(["prepared", "committed", "after_commit"]);
    expect(f.prisma.$transaction).toHaveBeenCalledTimes(1);
    expect(f.afterCommit.run).toHaveBeenCalledTimes(1);
  });

  it("rolls back the post, reward and view writes when a reward child fails, without afterCommit", async () => {
    const f = fixture({ failReward: true });
    await expect(
      f.service.createPost({
        ...normalPost,
        kind: "checkin",
        checkinDayKey: "2026-10-08",
        checkinPrompt: "Question",
      }),
    ).rejects.toThrow("reward write failed");
    expect(f.tx.post.create).toHaveBeenCalledTimes(1);
    expect(f.tx.user.updateMany).toHaveBeenCalledTimes(1);
    expect(f.state).toEqual({ posts: [], walletWrites: 0, viewWrites: 0 });
    expect(f.events).toEqual(["rolled_back"]);
    expect(f.afterCommit.run).not.toHaveBeenCalled();
  });

  it("passes the same transaction to quote and reward owners and reports the claimed reward", async () => {
    const f = fixture({ quote: true });
    const quoteRead = jest.spyOn(f.quotes, "resolve");
    const quoteCount = jest.spyOn(f.quotes, "record");
    const reward = jest.spyOn(f.checkins, "award");
    await expect(
      f.service.createPost({ ...normalPost, kind: "checkin" }),
    ).resolves.toMatchObject({
      streakReward: { coinsEarned: 2, streakDays: 8, multiplier: 2 },
    });
    expect(quoteRead).toHaveBeenCalledWith(
      f.tx,
      expect.objectContaining({ visibility: "verifiedOnly" }),
    );
    expect(quoteCount).toHaveBeenCalledWith(f.tx, "quoted");
    expect(reward).toHaveBeenCalledWith(f.tx, "author", now);
    expect(f.tx.post.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ quotedPostId: "quoted" }),
      }),
    );
    expect(f.afterCommit.run).toHaveBeenCalledWith(
      expect.objectContaining({ didAwardStreak: true, quotedPostId: "quoted" }),
    );
  });

  it("claims scheduled revisions before creating any publication and aborts stale claims", async () => {
    const f = fixture({ scheduledClaim: 0 });
    await expect(
      f.service.createPost({
        ...normalPost,
        scheduledSource: { id: "draft", revision: 3 },
      }),
    ).rejects.toThrow("changed or was already published");
    expect(f.tx.post.updateMany).toHaveBeenCalledWith({
      where: {
        id: "draft",
        userId: "author",
        scheduledRevision: 3,
        isDraft: true,
        deletedAt: null,
        scheduledAt: { not: null, lte: now },
        scheduledPublishedPostId: null,
      },
      data: { deletedAt: now, scheduledAt: null },
    });
    expect(f.tx.post.create).not.toHaveBeenCalled();
    expect(f.afterCommit.run).not.toHaveBeenCalled();
  });

  it("keeps parent and nested Board-root counter bumps in the same publication transaction", async () => {
    const f = fixture();
    await f.service.createPost({
      ...normalPost,
      kind: "board",
      parentId: "parent",
    });
    expect(f.tx.post.update).toHaveBeenCalledWith({
      where: { id: "parent" },
      data: { commentCount: { increment: 1 } },
      select: { commentCount: true },
    });
    expect(f.tx.post.update).toHaveBeenCalledWith({
      where: { id: "root" },
      data: { commentCount: { increment: 1 } },
      select: { commentCount: true },
    });
    expect(f.afterCommit.run).toHaveBeenCalledWith(
      expect.objectContaining({
        parentCommentCount: 4,
        boardRootCommentCount: 4,
        boardRootToBump: "root",
      }),
    );
  });
});
