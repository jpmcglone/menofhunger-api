import { Prisma } from '@prisma/client';
import { MarvinPublicReplyProcessor } from './marvin-public-reply.processor';
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
      publicThreadCooldownSeconds: 120,
      privateMaxPerUserPerDay: 60,
      privateMaxPer10Minutes: 10,
    })),
    marvCredits: jest.fn(() => ({
      monthlyCredits: 1200,
      maxCredits: 1500,
      creditsPerDay: 40,
      fastCost: 1,
      regularCost: 2,
      smartCost: 5,
      webSearchCreditCost: 4,
      visionCreditCostPerImage: 2,
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
    marvUsernameLower: jest.fn(() => 'marv'),
  };

  const posts: any = {
    createPost: jest.fn(async () => ({ post: { id: 'reply-1' } })),
  };

  const credits: any = {
    costForMode: jest.fn(() => 2),
    refill: jest.fn(async () => ({
      credits: opts?.credits ?? 100,
      maxCredits: 1500,
      creditsPerDay: 40,
      lastRefilledAt: new Date(),
    })),
    spend: jest.fn(async () => ({
      credits: (opts?.credits ?? 100) - 2,
      maxCredits: 1500,
      creditsPerDay: 40,
      lastRefilledAt: new Date(),
    })),
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

  const tools: any = { dispatch: jest.fn(async () => '{}') };

  const usage: any = {
    recordEvent: jest.fn(async () => undefined),
    countRecent: jest.fn(async () => 0),
    getLastReplyAtForRoot: jest.fn(async () => null),
  };

  const canned: any = {
    sendNonPremiumThreadReply: jest.fn(async () => 'reply-1'),
    sendOutOfCreditsDm: jest.fn(async () => ({ conversationId: 'c-1', messageId: 'm-1' })),
    sendNotConfiguredThreadReply: jest.fn(async () => 'reply-not-configured'),
  };

  const jobs: any = { enqueue: jest.fn(async () => undefined) };
  const threadSummary: any = { shouldSummarize: jest.fn(async () => false) };
  const linkMetadata: any = { previewLinks: jest.fn(async () => []) };

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
    linkMetadata,
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
    linkMetadata,
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
    expect(m.credits.spend).toHaveBeenCalledWith(
      'u-requester',
      2,
      expect.objectContaining({ recentSummary: expect.any(Object) }),
    );
    expect(m.usage.recordEvent).toHaveBeenCalledWith(
      expect.objectContaining({ creditsSpent: 2 }),
    );
    // Successful replies are recorded without an errorCode.
    const recordedCall = m.usage.recordEvent.mock.calls[0]![0];
    expect(recordedCall.errorCode).toBeUndefined();
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

  it('honors rate limits (per-day)', async () => {
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
    expect(m.usage.recordEvent).toHaveBeenCalledWith(
      expect.objectContaining({ errorCode: 'rate_limit_daily' }),
    );
  });

  it('honors per-thread cooldown', async () => {
    const m = makeProcessor();
    m.usage.getLastReplyAtForRoot.mockResolvedValueOnce(new Date(Date.now() - 1000));
    await m.processor.process({
      postId: 'p-1',
      rootPostId: 'r-1',
      requestingUserId: 'u-requester',
    });
    expect(m.posts.createPost).not.toHaveBeenCalled();
    expect(m.usage.recordEvent).toHaveBeenCalledWith(
      expect.objectContaining({ errorCode: 'thread_cooldown' }),
    );
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
      // root + reply for fetchThreadContext
      m.prisma.post.findFirst
        .mockResolvedValueOnce({ // root post fetch inside fetchThreadContext
          id: 'r-1', body: 'root', createdAt: new Date('2025-01-01'),
          checkinPrompt: null, userId: 'u-1', user: { username: 'alice', name: 'Alice' },
          media: [{ id: 'med-r1', kind: 'image', source: 'upload', r2Key: 'images/root.jpg', url: null, position: 0 }],
          poll: null,
        });
      m.prisma.post.findMany.mockResolvedValueOnce([]); // no replies
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
      // mode cost=2 + vision=2*2=4 → total=6
      expect(m.credits.spend).toHaveBeenCalledWith('u-requester', 6, expect.any(Object));
      expect(m.usage.recordEvent).toHaveBeenCalledWith(expect.objectContaining({ creditsSpent: 6 }));
    });
  });
});
