import { Prisma } from '@prisma/client';
import { MarvinPrivateReplyProcessor } from './marvin-private-reply.processor';

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
    },
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
      smartCost: 4,
      webSearchCreditCost: 2,
    })),
    marvOpenAI: jest.fn(() => ({
      apiKey: 'sk-test',
      promptId: 'pmpt_test',
      promptVersion: null,
      fastModel: 'gpt-5-nano',
      regularModel: 'gpt-5',
      smartModel: 'gpt-5',
      webSearchEnabled: false,
      webSearchModes: ['regular', 'smart'],
      webSearchMaxOutputTokens: 4096,
    })),
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
    resolve: jest.fn(() => ({ mode: 'regular', reason: 'user_selected', crisisDetected: false })),
    estimateTokens: jest.fn(() => 50),
  };

  const promptBuilder: any = {
    build: jest.fn(() => ({
      developerNote: 'note',
      userMessage: 'msg',
      allowedUsernamesLower: ['alice'],
    })),
  };

  const ai: any = {
    isConfigured: jest.fn(() => opts?.aiConfigured !== false),
    modelForMode: jest.fn(() => 'gpt-5'),
    respond: jest.fn(async () => ({
      text: opts?.aiText ?? 'Be steady, brother.',
      modelUsed: 'gpt-5',
      responseId: 'resp-2',
      inputTokens: 50,
      outputTokens: 40,
      cachedInputTokens: 0,
      estimatedCostUsd: 0.001,
      toolCallCount: 0,
      webSearchCount: 0,
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
  };

  const presenceRealtime: any = {
    emitMessagesTypingFromUser: jest.fn(),
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
    sessionStateUpsert,
    sessionStateFindUnique,
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
    it('emits typing:true before the AI call and typing:false after success', async () => {
      const m = makeProcessor();
      await m.processor.process({
        conversationId: 'c-1',
        messageId: 'm-1',
        requestingUserId: 'u-requester',
      });
      const calls = m.presenceRealtime.emitMessagesTypingFromUser.mock.calls;
      // First emit: typing=true (start). Last emit: typing=false (stop).
      expect(calls.length).toBeGreaterThanOrEqual(2);
      expect(calls[0]).toEqual([
        'u-requester',
        'marv-id',
        { conversationId: 'c-1', typing: true },
      ]);
      expect(calls[calls.length - 1]).toEqual([
        'u-requester',
        'marv-id',
        { conversationId: 'c-1', typing: false },
      ]);
    });

    it('emits typing:false even if the AI call throws', async () => {
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
      expect(calls[0]).toEqual([
        'u-requester',
        'marv-id',
        { conversationId: 'c-1', typing: true },
      ]);
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

  it('honors private rate-limit (per-day)', async () => {
    const m = makeProcessor();
    m.usage.countRecent
      .mockResolvedValueOnce(2) // 10-min window
      .mockResolvedValueOnce(99); // 24h window
    await m.processor.process({
      conversationId: 'c-1',
      messageId: 'm-1',
      requestingUserId: 'u-requester',
    });
    expect(m.messages.sendBotDirectMessage).not.toHaveBeenCalled();
    expect(m.usage.recordEvent).toHaveBeenCalledWith(
      expect.objectContaining({ errorCode: 'rate_limit_daily' }),
    );
  });
});
