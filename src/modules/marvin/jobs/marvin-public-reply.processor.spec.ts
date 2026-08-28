import { Prisma } from '@prisma/client';
import { MarvinPublicReplyProcessor } from './marvin-public-reply.processor';
import { MarvinThreadContextService } from '../services/marvin-thread-context.service';
import {
  MARV_DEFAULT_FAST_MODEL,
  MARV_DEFAULT_REGULAR_MODEL,
  MARV_DEFAULT_SMART_MODEL,
} from '../marvin-models';

function p2002(): Error {
  return new Prisma.PrismaClientKnownRequestError('Unique constraint failed', {
    code: 'P2002',
    clientVersion: 'test',
  });
}

function makeProcessor(opts?: {
  premium?: boolean;
  credits?: number;
  visibility?: string;
  alreadyClaimedIdempotency?: boolean;
  aiText?: string;
  aiConfigured?: boolean;
}) {
  const claimedKeys = new Set<string>();
  if (opts?.alreadyClaimedIdempotency) claimedKeys.add('any');

  const idempotencyCreate = jest.fn(async ({ data }: any) => {
    if (opts?.alreadyClaimedIdempotency || claimedKeys.has(data.key)) throw p2002();
    claimedKeys.add(data.key);
    return { key: data.key };
  });

  const post = {
    findFirst: jest.fn(async () => ({
      id: 'p-1',
      body: 'Hey @marv, what do you think about this?',
      visibility: opts?.visibility ?? 'public',
      rootId: 'r-1',
      userId: 'u-requester',
      user: {
        id: 'u-requester',
        username: 'alice',
        name: 'Alice',
        premium: opts?.premium ?? true,
        premiumPlus: false,
        bannedAt: null,
      },
      mentions: [],
      media: [],
      poll: null,
    })),
    findMany: jest.fn(async () => []),
  };

  const prisma: any = {
    marvinIdempotencyKey: { create: idempotencyCreate },
    marvinUserSettings: { findUnique: jest.fn(async () => null) },
    post,
    marvinUsageEvent: {
      create: jest.fn(async () => ({})),
      count: jest.fn(async () => 0),
      findFirst: jest.fn(async () => null),
    },
  };

  const appConfig: any = {
    marvBot: jest.fn(() => ({
      enabled: true,
      userId: 'marv-id',
      username: 'marv',
      displayName: 'Marv',
      bio: '',
      phone: '',
    })),
    marvLimits: jest.fn(() => ({
      publicMaxInputTokens: 8000,
      privateMaxInputTokens: 4000,
      maxOutputTokens: 1024,
      publicMaxPerUserPerHour: 10,
      publicMaxPerUserPerDay: 30,
      publicThreadBurstLimit: 3,
      publicThreadBurstWindowSeconds: 60,
      privateMaxPerUserPerDay: 60,
      privateMaxPer10Minutes: 10,
    })),
    marvCredits: jest.fn(() => ({
      monthlyCredits: 600,
      maxCredits: 600,
      creditsPerDay: 20,
      fastCost: 1,
      regularCost: 2,
      smartCost: 5,
      webSearchCreditCost: 5,
      visionCreditCostPerImage: 1,
      urlFetchCreditCost: 1,
    })),
    marvOpenAI: jest.fn(() => ({
      apiKey: 'sk-test',
      promptId: 'pmpt_test',
      promptVersion: null,
      fastModel: MARV_DEFAULT_FAST_MODEL,
      regularModel: MARV_DEFAULT_REGULAR_MODEL,
      smartModel: MARV_DEFAULT_SMART_MODEL,
      webSearchEnabled: false,
      webSearchModes: ['regular', 'smart'],
      webSearchMaxOutputTokens: 4096,
      visionEnabled: false,
      visionModes: ['regular', 'smart'],
      visionMaxImagesPerTurn: 4,
    })),
    r2: jest.fn(() => ({ publicBaseUrl: 'https://cdn.test' })),
    frontendBaseUrl: jest.fn(() => 'https://menofhunger.com'),
  };

  const identity: any = {
    getMarvUserId: jest.fn(async () => 'marv-id'),
    cachedMarvUserId: jest.fn(() => 'marv-id'),
    marvUsernameLower: jest.fn(() => 'marv'),
  };

  const posts: any = {
    createPost: jest.fn(async () => ({ post: { id: 'reply-1' } })),
  };

  const creditSummary = {
    credits: opts?.credits ?? 100,
    maxCredits: 600,
    creditsPerDay: 20,
    lastRefilledAt: new Date(),
  };
  const credits: any = {
    costForMode: jest.fn(() => 2),
    threadContextSurcharge: jest.fn(() => 0),
    refill: jest.fn(async () => ({ ...creditSummary })),
    reserve: jest.fn(async () => ({ ...creditSummary, credits: (opts?.credits ?? 100) - 2 })),
    settle: jest.fn(async () => ({ ...creditSummary, credits: (opts?.credits ?? 100) - 2 })),
    refund: jest.fn(async () => ({ ...creditSummary })),
    spend: jest.fn(async () => ({ ...creditSummary, credits: (opts?.credits ?? 100) - 2 })),
    msUntilCredits: jest.fn(() => 60 * 60 * 1000),
  };

  const routing: any = {
    resolve: jest.fn(() => ({ mode: 'regular', reason: 'user_selected', crisisDetected: false, webSearchDemanded: false })),
    estimateTokens: jest.fn(() => 50),
  };

  const promptBuilder: any = {
    build: jest.fn(() => ({
      developerNote: 'note',
      userMessage: 'msg',
    })),
  };

  const ai: any = {
    isConfigured: jest.fn(() => opts?.aiConfigured !== false),
    modelForMode: jest.fn(() => MARV_DEFAULT_REGULAR_MODEL),
    respond: jest.fn(async () => ({
      text: opts?.aiText ?? 'Brief, kind reply.',
      modelUsed: MARV_DEFAULT_REGULAR_MODEL,
      responseId: 'resp-1',
      inputTokens: 50,
      outputTokens: 40,
      cachedInputTokens: 0,
      estimatedCostUsd: 0.001,
      toolCallCount: 0,
      webSearchCount: 0,
      imagesAttached: 0,
    })),
  };

  const tools: any = {
    dispatch: jest.fn(async () => '{}'),
    collectMentionedMemberCards: jest.fn(async () => []),
    lookupMemberCards: jest.fn(async (usernames: string[]) =>
      usernames.map((username) => ({ username, cardText: null })),
    ),
  };

  const usage: any = {
    recordEvent: jest.fn(async () => undefined),
    countRecent: jest.fn(async () => 0),
    countRecentRepliesForRootAndUser: jest.fn(async () => 0),
  };

  const canned: any = {
    sendNonPremiumThreadReply: jest.fn(async () => 'reply-1'),
    sendOutOfCreditsDm: jest.fn(async () => ({ conversationId: 'c-1', messageId: 'm-1' })),
    sendNotConfiguredThreadReply: jest.fn(async () => 'reply-not-configured'),
    sendRateLimitedDm: jest.fn(async () => undefined),
  };

  const jobs: any = { enqueue: jest.fn(async () => undefined) };
  const threadSummary: any = {
    shouldSummarize: jest.fn(async () => false),
    getSummaryText: jest.fn(async () => null),
  };
  const threadContext: any = {
    collect: jest.fn(async () => ({
      focal: {
        id: 'post-1',
        parentId: null,
        rootId: 'root-1',
        depth: 0,
        authorUserId: 'user-1',
        authorUsername: 'asker',
        authorDisplayName: 'Asker',
        body: 'hey @marv',
        createdAt: new Date(),
        checkinPrompt: null,
        isMarv: false,
        media: [],
        poll: null,
      },
      ancestors: [],
      descendants: [],
      totalDescendants: 0,
      rootId: 'root-1',
      group: null,
    })),
    // Delegate to the real (pure) selection so vision tests exercise the shared code path.
    selectImageMedia: (ctx: any, opts: any) =>
      new MarvinThreadContextService({} as any, {} as any).selectImageMedia(ctx, opts),
  };
  const linkMetadata: any = { previewLinks: jest.fn(async () => []) };
  const presenceRealtime: any = { emitPostsTyping: jest.fn() };

  const processor = new MarvinPublicReplyProcessor(
    prisma,
    appConfig,
    identity,
    posts,
    credits,
    routing,
    promptBuilder,
    ai,
    tools,
    usage,
    canned,
    jobs,
    threadSummary,
    threadContext,
    linkMetadata,
    presenceRealtime,
  );

  return {
    processor,
    prisma,
    posts,
    credits,
    routing,
    ai,
    usage,
    canned,
    appConfig,
    identity,
    jobs,
    threadSummary,
    threadContext,
    linkMetadata,
    presenceRealtime,
  };
}

describe('MarvinPublicReplyProcessor', () => {
  it('short-circuits on duplicate idempotency key', async () => {
    const m = makeProcessor({ alreadyClaimedIdempotency: true });
    await m.processor.process({
      postId: 'p-1',
      rootPostId: 'r-1',
      requestingUserId: 'u-requester',
    });
    expect(m.posts.createPost).not.toHaveBeenCalled();
    expect(m.usage.recordEvent).not.toHaveBeenCalled();
  });

  it('skips when Marv is globally disabled', async () => {
    const m = makeProcessor();
    m.appConfig.marvBot.mockReturnValueOnce({
      enabled: false,
      userId: 'marv-id',
      username: 'marv',
      displayName: 'Marv',
      bio: '',
      phone: '',
    });
    await m.processor.process({
      postId: 'p-1',
      rootPostId: 'r-1',
      requestingUserId: 'u-requester',
    });
    expect(m.posts.createPost).not.toHaveBeenCalled();
  });

  it('sends canned non-premium reply for non-premium users', async () => {
    const m = makeProcessor({ premium: false });
    await m.processor.process({
      postId: 'p-1',
      rootPostId: 'r-1',
      requestingUserId: 'u-requester',
    });
    expect(m.canned.sendNonPremiumThreadReply).toHaveBeenCalledWith({
      requestingUserId: 'u-requester',
      triggeringPostId: 'p-1',
      rootPostId: 'r-1',
    });
    expect(m.posts.createPost).not.toHaveBeenCalled();
    expect(m.usage.recordEvent).toHaveBeenCalledWith(
      expect.objectContaining({ errorCode: 'not_premium' }),
    );
  });

  it('sends out-of-credits DM when balance is insufficient', async () => {
    const m = makeProcessor({ credits: 1 }); // cost is 2, so 1 is too low
    await m.processor.process({
      postId: 'p-1',
      rootPostId: 'r-1',
      requestingUserId: 'u-requester',
    });
    expect(m.canned.sendOutOfCreditsDm).toHaveBeenCalled();
    expect(m.posts.createPost).not.toHaveBeenCalled();
    expect(m.usage.recordEvent).toHaveBeenCalledWith(
      expect.objectContaining({ errorCode: 'no_credits' }),
    );
  });

  it('skips onlyMe posts with a usage event', async () => {
    const m = makeProcessor({ visibility: 'onlyMe' });
    await m.processor.process({
      postId: 'p-1',
      rootPostId: 'r-1',
      requestingUserId: 'u-requester',
    });
    expect(m.posts.createPost).not.toHaveBeenCalled();
    expect(m.usage.recordEvent).toHaveBeenCalledWith(
      expect.objectContaining({ errorCode: 'visibility_only_me' }),
    );
  });

  it('posts the canned "not configured" reply (idempotent) when AI is not configured', async () => {
    const m = makeProcessor({ aiConfigured: false });
    await m.processor.process({
      postId: 'p-1',
      rootPostId: 'r-1',
      requestingUserId: 'u-requester',
    });
    // We never go through the model-driven createPost path...
    expect(m.posts.createPost).not.toHaveBeenCalled();
    // ...but we DO surface a canned thread reply so the user knows Marv isn't ignoring them.
    expect(m.canned.sendNotConfiguredThreadReply).toHaveBeenCalledWith({
      requestingUserId: 'u-requester',
      triggeringPostId: 'p-1',
      rootPostId: 'r-1',
    });
    // Usage event still records the reason for observability.
    expect(m.usage.recordEvent).toHaveBeenCalledWith(
      expect.objectContaining({ errorCode: 'ai_not_configured' }),
    );
  });

  it('does not call sendNotConfiguredThreadReply when AI is properly configured', async () => {
    const m = makeProcessor();
    await m.processor.process({
      postId: 'p-1',
      rootPostId: 'r-1',
      requestingUserId: 'u-requester',
    });
    expect(m.canned.sendNotConfiguredThreadReply).not.toHaveBeenCalled();
  });

  it('happy path: posts AI reply via PostsService and spends credits', async () => {
    const m = makeProcessor();
    await m.processor.process({
      postId: 'p-1',
      rootPostId: 'r-1',
      requestingUserId: 'u-requester',
    });
    expect(m.posts.createPost).toHaveBeenCalledWith(
      expect.objectContaining({
        userId: 'marv-id',
        body: 'Brief, kind reply.',
        parentId: 'p-1',
      }),
    );
    expect(m.credits.reserve).toHaveBeenCalledWith(
      'u-requester',
      3,
      expect.objectContaining({ recentSummary: expect.any(Object) }),
    );
    expect(m.credits.settle).toHaveBeenCalledWith('u-requester', 3, 2);
    expect(m.usage.recordEvent).toHaveBeenCalledWith(
      expect.objectContaining({ creditsSpent: 2 }),
    );
    // Successful replies are recorded without an errorCode.
    const recordedCall = m.usage.recordEvent.mock.calls[0]![0];
    expect(recordedCall.errorCode).toBeUndefined();
  });

  describe('typing indicator', () => {
    const typingUser = {
      id: 'marv-id',
      username: 'marv',
      verifiedStatus: 'manual',
      premium: true,
      premiumPlus: false,
      isOrganization: false,
    };

    it('emits thinking→replying on the triggering post, then typing:false', async () => {
      const m = makeProcessor();
      await m.processor.process({
        postId: 'p-1',
        rootPostId: 'r-1',
        requestingUserId: 'u-requester',
      });
      const calls = m.presenceRealtime.emitPostsTyping.mock.calls;
      expect(calls[0]).toEqual([
        'p-1',
        { postId: 'p-1', user: typingUser, typing: true, status: 'thinking' },
      ]);
      expect(calls.find((c: unknown[]) => (c[1] as { status?: string })?.status === 'replying')).toEqual([
        'p-1',
        { postId: 'p-1', user: typingUser, typing: true, status: 'replying' },
      ]);
      expect(calls[calls.length - 1]).toEqual([
        'p-1',
        { postId: 'p-1', user: typingUser, typing: false },
      ]);
    });

    it('emits typing:false even if the AI call throws (no replying phase)', async () => {
      const m = makeProcessor();
      m.ai.respond = jest.fn(async () => {
        throw new Error('upstream timeout');
      });
      await m.processor.process({
        postId: 'p-1',
        rootPostId: 'r-1',
        requestingUserId: 'u-requester',
      });
      const calls = m.presenceRealtime.emitPostsTyping.mock.calls;
      expect(calls[0]).toEqual([
        'p-1',
        { postId: 'p-1', user: typingUser, typing: true, status: 'thinking' },
      ]);
      expect(calls.find((c: unknown[]) => (c[1] as { status?: string })?.status === 'replying')).toBeUndefined();
      expect(calls[calls.length - 1]).toEqual([
        'p-1',
        { postId: 'p-1', user: typingUser, typing: false },
      ]);
    });

    it('does not emit typing for the canned not-configured path', async () => {
      const m = makeProcessor({ aiConfigured: false });
      await m.processor.process({
        postId: 'p-1',
        rootPostId: 'r-1',
        requestingUserId: 'u-requester',
      });
      expect(m.presenceRealtime.emitPostsTyping).not.toHaveBeenCalled();
    });

    it('does not emit typing on the out-of-credits path', async () => {
      const m = makeProcessor({ credits: 1 });
      await m.processor.process({
        postId: 'p-1',
        rootPostId: 'r-1',
        requestingUserId: 'u-requester',
      });
      expect(m.presenceRealtime.emitPostsTyping).not.toHaveBeenCalled();
    });
  });

  it('records ai_no_text when the AI returns empty', async () => {
    const m = makeProcessor({ aiText: '' });
    await m.processor.process({
      postId: 'p-1',
      rootPostId: 'r-1',
      requestingUserId: 'u-requester',
    });
    expect(m.posts.createPost).not.toHaveBeenCalled();
    expect(m.usage.recordEvent).toHaveBeenCalledWith(
      expect.objectContaining({ errorCode: 'ai_no_text' }),
    );
  });

  it('honors rate limits (per-day) and DMs the user with a post link', async () => {
    const m = makeProcessor();
    m.usage.countRecent
      .mockResolvedValueOnce(2) // hourly
      .mockResolvedValueOnce(99); // daily — exceeds 30
    await m.processor.process({
      postId: 'p-1',
      rootPostId: 'r-1',
      requestingUserId: 'u-requester',
    });
    expect(m.posts.createPost).not.toHaveBeenCalled();
    expect(m.canned.sendRateLimitedDm).toHaveBeenCalledWith({
      userId: 'u-requester',
      kind: 'daily',
      triggeringPostId: 'p-1',
    });
    expect(m.usage.recordEvent).toHaveBeenCalledWith(
      expect.objectContaining({ errorCode: 'rate_limit_daily' }),
    );
  });

  it('honors per-(thread,user) burst limit and DMs the user with a post link', async () => {
    const m = makeProcessor();
    // At/over the burst limit of 3 within the window — next mention should be blocked.
    m.usage.countRecentRepliesForRootAndUser.mockResolvedValueOnce(3);
    await m.processor.process({
      postId: 'p-1',
      rootPostId: 'r-1',
      requestingUserId: 'u-requester',
    });
    expect(m.usage.countRecentRepliesForRootAndUser).toHaveBeenCalledWith({
      rootPostId: 'r-1',
      userId: 'u-requester',
      windowSeconds: 60,
    });
    expect(m.posts.createPost).not.toHaveBeenCalled();
    expect(m.canned.sendRateLimitedDm).toHaveBeenCalledWith({
      userId: 'u-requester',
      kind: 'thread_cooldown',
      triggeringPostId: 'p-1',
    });
    expect(m.usage.recordEvent).toHaveBeenCalledWith(
      expect.objectContaining({ errorCode: 'thread_cooldown' }),
    );
  });

  it('allows replies while under the per-(thread,user) burst limit', async () => {
    const m = makeProcessor();
    // 2 recent successful replies — still under the limit of 3, so this 3rd attempt
    // should pass through the rate-limit gate (not be blocked).
    m.usage.countRecentRepliesForRootAndUser.mockResolvedValueOnce(2);
    await m.processor.process({
      postId: 'p-1',
      rootPostId: 'r-1',
      requestingUserId: 'u-requester',
    });
    expect(m.canned.sendRateLimitedDm).not.toHaveBeenCalled();
  });

  it('rolls over: a 4th mention after the window passes is NOT blocked', async () => {
    // This locks in the sliding-window behavior at the processor level. The burst
    // limiter must release the user as soon as old events fall out of the window —
    // it must NOT be a per-thread permanent cap.
    const m = makeProcessor();

    // First attempt: at the limit (3 prior successes in window) → blocked.
    m.usage.countRecentRepliesForRootAndUser.mockResolvedValueOnce(3);
    await m.processor.process({
      postId: 'p-1',
      rootPostId: 'r-1',
      requestingUserId: 'u-requester',
    });
    expect(m.canned.sendRateLimitedDm).toHaveBeenCalledTimes(1);
    expect(m.posts.createPost).not.toHaveBeenCalled();

    // Second attempt: window has rolled, the prior successes have aged out → count=0.
    // The processor must let this one through and post a public reply.
    m.usage.countRecentRepliesForRootAndUser.mockResolvedValueOnce(0);
    await m.processor.process({
      postId: 'p-2',
      rootPostId: 'r-1',
      requestingUserId: 'u-requester',
    });

    // Still only the one cooldown DM from the first attempt — no new block.
    expect(m.canned.sendRateLimitedDm).toHaveBeenCalledTimes(1);
    expect(m.posts.createPost).toHaveBeenCalled();
  });

  it('does not block one user just because another user hit the burst limit in the same thread', async () => {
    // Locks in per-(thread, user) scoping at the processor level — the usage service
    // is queried with the specific requesting userId, so a different user pinging
    // Marv in the same thread has their own independent budget.
    const m = makeProcessor();

    // Simulate: user A burned through the limit in this thread (the count reflects
    // their events, not anyone else's). User B's call returns 0 because the service
    // filters by userId, so this call shouldn't be blocked.
    m.usage.countRecentRepliesForRootAndUser.mockResolvedValueOnce(0);
    await m.processor.process({
      postId: 'p-1',
      rootPostId: 'r-1',
      requestingUserId: 'u-second-user',
    });

    expect(m.usage.countRecentRepliesForRootAndUser).toHaveBeenCalledWith({
      rootPostId: 'r-1',
      userId: 'u-second-user',
      windowSeconds: 60,
    });
    expect(m.canned.sendRateLimitedDm).not.toHaveBeenCalled();
    expect(m.posts.createPost).toHaveBeenCalled();
  });

  describe('vision: image selection (first-then-tail rule)', () => {
    it('passes images from thread when vision is enabled', async () => {
      const m = makeProcessor();
      m.appConfig.marvOpenAI.mockReturnValue({
        apiKey: 'sk-test', promptId: 'pmpt_test', promptVersion: null,
        fastModel: MARV_DEFAULT_FAST_MODEL, regularModel: MARV_DEFAULT_REGULAR_MODEL, smartModel: MARV_DEFAULT_SMART_MODEL,
        webSearchEnabled: false, webSearchModes: ['regular', 'smart'], webSearchMaxOutputTokens: 4096,
        visionEnabled: true, visionModes: ['regular', 'smart'], visionMaxImagesPerTurn: 4,
      });
      // triggering post has one upload image
      m.prisma.post.findFirst.mockResolvedValueOnce({
        id: 'p-1',
        body: 'Check this photo',
        visibility: 'public',
        rootId: 'r-1',
        userId: 'u-requester',
        user: { id: 'u-requester', username: 'alice', name: 'Alice', premium: true, premiumPlus: false, bannedAt: null },
        mentions: [],
        media: [{ id: 'med-1', kind: 'image', source: 'upload', r2Key: 'images/photo.jpg', url: null, position: 0 }],
        poll: null,
      });
      // Bidirectional context: focal post carries an upload image for vision selection.
      m.threadContext.collect.mockResolvedValueOnce({
        focal: {
          id: 'p-1', parentId: null, rootId: 'r-1', depth: 0,
          authorUserId: 'u-requester', authorUsername: 'alice', authorDisplayName: 'Alice',
          body: 'Check this photo', createdAt: new Date('2025-01-01'), editedAt: null,
          checkinPrompt: null, isMarv: false,
          media: [{ kind: 'image', source: 'upload', r2Key: 'images/photo.jpg', url: null }],
          poll: null,
        },
        ancestors: [],
        descendants: [],
        totalDescendants: 0,
        rootId: 'r-1',
      });
      await m.processor.process({ postId: 'p-1', rootPostId: 'r-1', requestingUserId: 'u-requester' });
      // Should call AI with imageUrls populated
      const aiCall = m.ai.respond.mock.calls[0]?.[0];
      expect(aiCall?.imageUrls?.length).toBeGreaterThanOrEqual(1);
    });

    it('does not pass imageUrls when vision is disabled', async () => {
      const m = makeProcessor();
      m.prisma.post.findFirst
        .mockResolvedValueOnce({
          id: 'p-1', body: 'Check this', visibility: 'public', rootId: 'r-1', userId: 'u-requester',
          user: { id: 'u-requester', username: 'alice', name: 'Alice', premium: true, premiumPlus: false, bannedAt: null },
          mentions: [],
          media: [{ id: 'med-1', kind: 'image', source: 'upload', r2Key: 'images/x.jpg', url: null, position: 0 }],
          poll: null,
        })
        .mockResolvedValueOnce({ // root in fetchThreadContext
          id: 'r-1', body: 'root', createdAt: new Date(), checkinPrompt: null, userId: 'u-1',
          user: { username: 'alice', name: 'Alice' }, media: [], poll: null,
        });
      m.prisma.post.findMany.mockResolvedValueOnce([]);
      await m.processor.process({ postId: 'p-1', rootPostId: 'r-1', requestingUserId: 'u-requester' });
      const aiCall = m.ai.respond.mock.calls[0]?.[0];
      expect(aiCall?.imageUrls).toBeUndefined();
    });
  });

  describe('vision: credit surcharge', () => {
    it('adds vision surcharge to totalCost when images were attached', async () => {
      const m = makeProcessor();
      m.ai.respond.mockResolvedValueOnce({
        text: 'I see it.', modelUsed: MARV_DEFAULT_REGULAR_MODEL, responseId: 'resp-2',
        inputTokens: 200, outputTokens: 30, cachedInputTokens: 0, estimatedCostUsd: 0.002,
        toolCallCount: 0, webSearchCount: 0, imagesAttached: 2,
      });
      await m.processor.process({ postId: 'p-1', rootPostId: 'r-1', requestingUserId: 'u-requester' });
      // mode cost=2 + vision=2*1=2 → total=4
      expect(m.credits.settle).toHaveBeenCalledWith('u-requester', 3, 4);
      expect(m.usage.recordEvent).toHaveBeenCalledWith(expect.objectContaining({ creditsSpent: 4 }));
    });
  });
});
