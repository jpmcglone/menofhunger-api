import { Prisma } from '@prisma/client';
import { MarvinPrivateReplyProcessor } from './marvin-private-reply.processor';
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
  alreadyClaimedIdempotency?: boolean;
  aiText?: string;
  aiConfigured?: boolean;
  /** Existing chained response id from a prior turn. */
  previousResponseId?: string | null;
}) {
  const claimedKeys = new Set<string>();
  if (opts?.alreadyClaimedIdempotency) claimedKeys.add('any');

  const idempotencyCreate = jest.fn(async ({ data }: any) => {
    if (opts?.alreadyClaimedIdempotency || claimedKeys.has(data.key)) throw p2002();
    claimedKeys.add(data.key);
    return { key: data.key };
  });

  const sessionStateUpsert = jest.fn(async () => ({ conversationId: 'c-1' }));
  const sessionStateFindUnique = jest.fn(async () =>
    opts?.previousResponseId == null ? null : { lastResponseId: opts.previousResponseId },
  );

  const messageFindFirst = jest.fn(async () => ({
    id: 'm-1',
    body: 'Hey Marv, how do I stay consistent?',
    senderId: 'u-requester',
    sender: {
      id: 'u-requester',
      username: 'alice',
      name: 'Alice',
      premium: opts?.premium ?? true,
      premiumPlus: false,
      bannedAt: null,
    },
    media: [],
    replyTo: null,
  }));

  const prisma: any = {
    marvinIdempotencyKey: { create: idempotencyCreate },
    marvinUserSettings: { findUnique: jest.fn(async () => null) },
    marvinPrivateSessionState: {
      findUnique: sessionStateFindUnique,
      upsert: sessionStateUpsert,
    },
    message: { findFirst: messageFindFirst },
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

  const messages: any = {
    sendBotDirectMessage: jest.fn(async () => ({
      conversationId: 'c-1',
      message: { id: 'reply-1' },
    })),
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
      text: opts?.aiText ?? 'Be steady, brother.',
      modelUsed: MARV_DEFAULT_REGULAR_MODEL,
      responseId: 'resp-2',
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
  };

  const canned: any = {
    sendOutOfCreditsDm: jest.fn(async () => ({ conversationId: 'c-1', messageId: 'm-1' })),
    sendNotConfiguredDm: jest.fn(async () => ({ conversationId: 'c-1', messageId: 'm-not-configured' })),
    sendTransientErrorDm: jest.fn(async () => undefined),
    sendRateLimitedDm: jest.fn(async () => undefined),
  };

  const presenceRealtime: any = {
    emitMessagesTypingFromUser: jest.fn(),
  };

  const linkMetadata: any = {
    previewLinks: jest.fn(async () => []),
  };

  // The cached marv id is used for the typing heartbeat to avoid a DB round-trip
  // on the hot path. Tests set it explicitly so the heartbeat actually emits.
  identity.cachedMarvUserId = jest.fn(() => 'marv-id');

  const processor = new MarvinPrivateReplyProcessor(
    prisma,
    appConfig,
    identity,
    messages,
    credits,
    routing,
    promptBuilder,
    ai,
    tools,
    usage,
    canned,
    presenceRealtime,
    linkMetadata,
  );

  return {
    processor,
    prisma,
    messages,
    credits,
    routing,
    ai,
    usage,
    canned,
    presenceRealtime,
    linkMetadata,
    sessionStateUpsert,
    sessionStateFindUnique,
    appConfig,
  };
}

describe('MarvinPrivateReplyProcessor', () => {
  it('short-circuits on duplicate idempotency key', async () => {
    const m = makeProcessor({ alreadyClaimedIdempotency: true });
    await m.processor.process({
      conversationId: 'c-1',
      messageId: 'm-1',
      requestingUserId: 'u-requester',
    });
    expect(m.messages.sendBotDirectMessage).not.toHaveBeenCalled();
    expect(m.usage.recordEvent).not.toHaveBeenCalled();
  });

  it('non-premium senders get a canned premium-only DM (no AI call)', async () => {
    const m = makeProcessor({ premium: false });
    await m.processor.process({
      conversationId: 'c-1',
      messageId: 'm-1',
      requestingUserId: 'u-requester',
    });
    expect(m.ai.respond).not.toHaveBeenCalled();
    expect(m.messages.sendBotDirectMessage).toHaveBeenCalledWith(
      expect.objectContaining({ recipientUserId: 'u-requester' }),
    );
    expect(m.usage.recordEvent).toHaveBeenCalledWith(
      expect.objectContaining({ errorCode: 'not_premium', source: 'private_session' }),
    );
  });

  it('out of credits sends canned DM and records no_credits', async () => {
    const m = makeProcessor({ credits: 1 });
    await m.processor.process({
      conversationId: 'c-1',
      messageId: 'm-1',
      requestingUserId: 'u-requester',
    });
    expect(m.canned.sendOutOfCreditsDm).toHaveBeenCalled();
    expect(m.ai.respond).not.toHaveBeenCalled();
    expect(m.usage.recordEvent).toHaveBeenCalledWith(
      expect.objectContaining({ errorCode: 'no_credits' }),
    );
  });

  it('chains previous_response_id from MarvinPrivateSessionState', async () => {
    const m = makeProcessor({ previousResponseId: 'resp-prev' });
    await m.processor.process({
      conversationId: 'c-1',
      messageId: 'm-1',
      requestingUserId: 'u-requester',
    });
    expect(m.ai.respond).toHaveBeenCalledWith(
      expect.objectContaining({ previousResponseId: 'resp-prev' }),
    );
  });

  it('happy path: sends AI reply via MessagesService, persists session state, spends credits', async () => {
    const m = makeProcessor();
    await m.processor.process({
      conversationId: 'c-1',
      messageId: 'm-1',
      requestingUserId: 'u-requester',
    });
    expect(m.messages.sendBotDirectMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        botUserId: 'marv-id',
        recipientUserId: 'u-requester',
        body: 'Be steady, brother.',
      }),
    );
    expect(m.sessionStateUpsert).toHaveBeenCalled();
    expect(m.credits.spend).toHaveBeenCalledWith(
      'u-requester',
      2,
      expect.objectContaining({ recentSummary: expect.any(Object) }),
    );
    expect(m.usage.recordEvent).toHaveBeenCalledWith(
      expect.objectContaining({ creditsSpent: 2, source: 'private_session' }),
    );
    const recordedCall = m.usage.recordEvent.mock.calls[0]![0];
    expect(recordedCall.errorCode).toBeUndefined();
  });

  it('records ai_no_text when the AI returns empty', async () => {
    const m = makeProcessor({ aiText: '' });
    await m.processor.process({
      conversationId: 'c-1',
      messageId: 'm-1',
      requestingUserId: 'u-requester',
    });
    expect(m.messages.sendBotDirectMessage).not.toHaveBeenCalled();
    expect(m.usage.recordEvent).toHaveBeenCalledWith(
      expect.objectContaining({ errorCode: 'ai_no_text' }),
    );
  });

  it('sends transient-error DM when the AI call throws a non-configured error', async () => {
    const m = makeProcessor();
    m.ai.respond = jest.fn(async () => {
      throw new Error('OpenAI 429 rate limit exceeded');
    });
    const transientDm = jest.fn(async () => undefined);
    m.canned.sendTransientErrorDm = transientDm;
    await m.processor.process({
      conversationId: 'c-1',
      messageId: 'm-1',
      requestingUserId: 'u-requester',
    });
    expect(transientDm).toHaveBeenCalledWith({ userId: 'u-requester' });
    expect(m.usage.recordEvent).toHaveBeenCalledWith(
      expect.objectContaining({ errorCode: 'ai_error' }),
    );
  });

  it('sends the canned "not configured" DM (idempotent) when AI is not configured', async () => {
    const m = makeProcessor({ aiConfigured: false });
    await m.processor.process({
      conversationId: 'c-1',
      messageId: 'm-1',
      requestingUserId: 'u-requester',
    });
    // Real AI never runs.
    expect(m.ai.respond).not.toHaveBeenCalled();
    // Canned DM goes out so the user knows Marv isn't ignoring them.
    expect(m.canned.sendNotConfiguredDm).toHaveBeenCalledWith({
      userId: 'u-requester',
      conversationId: 'c-1',
    });
    // Still record the reason for observability.
    expect(m.usage.recordEvent).toHaveBeenCalledWith(
      expect.objectContaining({ errorCode: 'ai_not_configured' }),
    );
  });

  it('does not call sendNotConfiguredDm when AI is properly configured', async () => {
    const m = makeProcessor();
    await m.processor.process({
      conversationId: 'c-1',
      messageId: 'm-1',
      requestingUserId: 'u-requester',
    });
    expect(m.canned.sendNotConfiguredDm).not.toHaveBeenCalled();
  });

  describe('typing indicator', () => {
    it('emits thinking→typing phases then typing:false on success', async () => {
      const m = makeProcessor();
      await m.processor.process({
        conversationId: 'c-1',
        messageId: 'm-1',
        requestingUserId: 'u-requester',
      });
      const calls = m.presenceRealtime.emitMessagesTypingFromUser.mock.calls;
      // First emit: typing=true with status='thinking'.
      expect(calls.length).toBeGreaterThanOrEqual(2);
      expect(calls[0]).toEqual([
        'u-requester',
        'marv-id',
        { conversationId: 'c-1', typing: true, status: 'thinking' },
      ]);
      // After AI succeeds there should be a typing=true with status='typing'.
      const typingPhase = calls.find((c: unknown[]) => (c[2] as Record<string, unknown>)?.status === 'typing');
      expect(typingPhase).toBeDefined();
      // Last emit: typing=false (stop).
      expect(calls[calls.length - 1]).toEqual([
        'u-requester',
        'marv-id',
        { conversationId: 'c-1', typing: false },
      ]);
    });

    it('emits typing:false even if the AI call throws (no typing phase)', async () => {
      const m = makeProcessor();
      m.ai.respond = jest.fn(async () => {
        throw new Error('upstream timeout');
      });
      await m.processor.process({
        conversationId: 'c-1',
        messageId: 'm-1',
        requestingUserId: 'u-requester',
      });
      const calls = m.presenceRealtime.emitMessagesTypingFromUser.mock.calls;
      expect(calls.length).toBeGreaterThanOrEqual(2);
      // Starts as thinking.
      expect(calls[0]).toEqual([
        'u-requester',
        'marv-id',
        { conversationId: 'c-1', typing: true, status: 'thinking' },
      ]);
      // No typing phase on error path.
      expect(calls.find((c: unknown[]) => (c[2] as Record<string, unknown>)?.status === 'typing')).toBeUndefined();
      // Last emit: typing=false.
      expect(calls[calls.length - 1]).toEqual([
        'u-requester',
        'marv-id',
        { conversationId: 'c-1', typing: false },
      ]);
    });

    it('does not emit typing for the canned not-configured path', async () => {
      const m = makeProcessor({ aiConfigured: false });
      await m.processor.process({
        conversationId: 'c-1',
        messageId: 'm-1',
        requestingUserId: 'u-requester',
      });
      // Canned reply is instant — no typing dots needed.
      expect(m.presenceRealtime.emitMessagesTypingFromUser).not.toHaveBeenCalled();
    });

    it('does not emit typing on the out-of-credits path', async () => {
      const m = makeProcessor({ credits: 1 });
      await m.processor.process({
        conversationId: 'c-1',
        messageId: 'm-1',
        requestingUserId: 'u-requester',
      });
      expect(m.presenceRealtime.emitMessagesTypingFromUser).not.toHaveBeenCalled();
    });
  });

  it('honors private rate-limit (per-day) and sends a canned DM', async () => {
    const m = makeProcessor();
    m.usage.countRecent
      .mockResolvedValueOnce(2) // 10-min window
      .mockResolvedValueOnce(99); // 24h window
    await m.processor.process({
      conversationId: 'c-1',
      messageId: 'm-1',
      requestingUserId: 'u-requester',
    });
    expect(m.canned.sendRateLimitedDm).toHaveBeenCalledWith({ userId: 'u-requester', kind: 'daily' });
    expect(m.usage.recordEvent).toHaveBeenCalledWith(
      expect.objectContaining({ errorCode: 'rate_limit_daily' }),
    );
  });

  describe('vision: image selection', () => {
    it('passes message images to AI when vision is enabled for the mode', async () => {
      const m = makeProcessor();
      // Enable vision for regular mode.
      m.appConfig.marvOpenAI.mockReturnValue({
        apiKey: 'sk-test', promptId: 'pmpt_test', promptVersion: null,
        fastModel: MARV_DEFAULT_FAST_MODEL, regularModel: MARV_DEFAULT_REGULAR_MODEL, smartModel: MARV_DEFAULT_SMART_MODEL,
        webSearchEnabled: false, webSearchModes: ['regular', 'smart'], webSearchMaxOutputTokens: 4096,
        visionEnabled: true, visionModes: ['regular', 'smart'], visionMaxImagesPerTurn: 4,
      });
      // Inject an image into the message.
      m.prisma.message.findFirst.mockResolvedValueOnce({
        id: 'm-1',
        body: 'Check this out',
        senderId: 'u-requester',
        sender: { id: 'u-requester', username: 'alice', name: 'Alice', premium: true, premiumPlus: false, bannedAt: null },
        media: [{ id: 'med-1', kind: 'image', source: 'upload', r2Key: 'images/foo.jpg', url: null }],
        replyTo: null,
      });
      await m.processor.process({ conversationId: 'c-1', messageId: 'm-1', requestingUserId: 'u-requester' });
      expect(m.ai.respond).toHaveBeenCalledWith(
        expect.objectContaining({ imageUrls: ['https://cdn.test/images/foo.jpg'] }),
      );
    });

    it('falls back to replyTo images when message has none', async () => {
      const m = makeProcessor();
      m.appConfig.marvOpenAI.mockReturnValue({
        apiKey: 'sk-test', promptId: 'pmpt_test', promptVersion: null,
        fastModel: MARV_DEFAULT_FAST_MODEL, regularModel: MARV_DEFAULT_REGULAR_MODEL, smartModel: MARV_DEFAULT_SMART_MODEL,
        webSearchEnabled: false, webSearchModes: ['regular', 'smart'], webSearchMaxOutputTokens: 4096,
        visionEnabled: true, visionModes: ['regular', 'smart'], visionMaxImagesPerTurn: 4,
      });
      m.prisma.message.findFirst.mockResolvedValueOnce({
        id: 'm-1',
        body: 'Re: that image',
        senderId: 'u-requester',
        sender: { id: 'u-requester', username: 'alice', name: 'Alice', premium: true, premiumPlus: false, bannedAt: null },
        media: [],
        replyTo: { body: 'original', media: [{ id: 'med-2', kind: 'image', source: 'giphy', r2Key: null, url: 'https://giphy.com/abc.gif' }] },
      });
      await m.processor.process({ conversationId: 'c-1', messageId: 'm-1', requestingUserId: 'u-requester' });
      expect(m.ai.respond).toHaveBeenCalledWith(
        expect.objectContaining({ imageUrls: ['https://giphy.com/abc.gif'] }),
      );
    });

    it('does not pass imageUrls when vision is disabled', async () => {
      const m = makeProcessor();
      m.prisma.message.findFirst.mockResolvedValueOnce({
        id: 'm-1',
        body: 'Check this out',
        senderId: 'u-requester',
        sender: { id: 'u-requester', username: 'alice', name: 'Alice', premium: true, premiumPlus: false, bannedAt: null },
        media: [{ id: 'med-1', kind: 'image', source: 'upload', r2Key: 'images/foo.jpg', url: null }],
        replyTo: null,
      });
      await m.processor.process({ conversationId: 'c-1', messageId: 'm-1', requestingUserId: 'u-requester' });
      const aiCall = m.ai.respond.mock.calls[0]![0];
      expect(aiCall.imageUrls).toBeUndefined();
    });
  });

  describe('vision: credit surcharge', () => {
    it('includes vision surcharge in totalCost when images are attached', async () => {
      const m = makeProcessor();
      // AI reports 2 images attached.
      m.ai.respond.mockResolvedValueOnce({
        text: 'I see it.', modelUsed: MARV_DEFAULT_REGULAR_MODEL, responseId: 'resp-3',
        inputTokens: 200, outputTokens: 30, cachedInputTokens: 0, estimatedCostUsd: 0.002,
        toolCallCount: 0, webSearchCount: 0, imagesAttached: 2,
      });
      await m.processor.process({ conversationId: 'c-1', messageId: 'm-1', requestingUserId: 'u-requester' });
      // cost=2 (regular) + vision=2*2=4 = 6
      expect(m.credits.spend).toHaveBeenCalledWith('u-requester', 6, expect.any(Object));
      expect(m.usage.recordEvent).toHaveBeenCalledWith(expect.objectContaining({ creditsSpent: 6 }));
    });
  });

  describe('credit pre-check: vision buffer', () => {
    it('blocks when credits < cost + vision buffer', async () => {
      const m = makeProcessor({ credits: 3 }); // cost=2, vision buffer would push to 4+
      m.appConfig.marvOpenAI.mockReturnValue({
        apiKey: 'sk-test', promptId: 'pmpt_test', promptVersion: null,
        fastModel: MARV_DEFAULT_FAST_MODEL, regularModel: MARV_DEFAULT_REGULAR_MODEL, smartModel: MARV_DEFAULT_SMART_MODEL,
        webSearchEnabled: false, webSearchModes: ['regular', 'smart'], webSearchMaxOutputTokens: 4096,
        visionEnabled: true, visionModes: ['regular', 'smart'], visionMaxImagesPerTurn: 4,
      });
      m.prisma.message.findFirst.mockResolvedValueOnce({
        id: 'm-1',
        body: 'Check this out',
        senderId: 'u-requester',
        sender: { id: 'u-requester', username: 'alice', name: 'Alice', premium: true, premiumPlus: false, bannedAt: null },
        media: [
          { id: 'med-1', kind: 'image', source: 'upload', r2Key: 'a.jpg', url: null },
          { id: 'med-2', kind: 'image', source: 'upload', r2Key: 'b.jpg', url: null },
        ],
        replyTo: null,
      });
      await m.processor.process({ conversationId: 'c-1', messageId: 'm-1', requestingUserId: 'u-requester' });
      // credits=3, reserved=2 (mode) + 4 (vision 2*2) = 6 > 3 → blocked
      expect(m.ai.respond).not.toHaveBeenCalled();
      expect(m.canned.sendOutOfCreditsDm).toHaveBeenCalled();
      expect(m.usage.recordEvent).toHaveBeenCalledWith(expect.objectContaining({ errorCode: 'no_credits' }));
    });
  });
});
