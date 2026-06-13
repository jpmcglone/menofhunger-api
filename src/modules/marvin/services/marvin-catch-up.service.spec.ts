import { ForbiddenException, HttpException } from '@nestjs/common';
import { MarvinCatchUpService } from './marvin-catch-up.service';
import { MarvinThreadContextService } from './marvin-thread-context.service';
import type { MarvinCatchUpDto } from '../../../common/dto/marvin';

/**
 * MarvinCatchUpService gates (enabled + premium + visibility + credits), then summarizes
 * a thread around a focal post. Invariants:
 *  1. Cache hits return the stored summary with creditsSpent=0 and never call the model.
 *  2. Non-premium users are rejected.
 *  3. Out-of-credits is rejected BEFORE any spend.
 *  4. The happy path spends credits and records a usage event (which emits credits).
 */

function makeContext() {
  return {
    focal: {
      id: 'focal',
      parentId: 'parent',
      rootId: 'root',
      depth: 0,
      authorUserId: 'u-focal',
      authorUsername: 'focalguy',
      authorDisplayName: 'Focal Guy',
      body: 'the focal post',
      createdAt: new Date('2026-01-01T00:00:00Z'),
      editedAt: null,
      checkinPrompt: null,
      isMarv: false,
      media: [],
      poll: null,
    },
    ancestors: [
      {
        id: 'root',
        parentId: null,
        rootId: null,
        depth: -1,
        authorUserId: 'u-root',
        authorUsername: 'rootguy',
        authorDisplayName: 'Root Guy',
        body: 'the original',
        createdAt: new Date('2026-01-01T00:00:00Z'),
        editedAt: null,
        checkinPrompt: null,
        isMarv: false,
        media: [],
        poll: null,
      },
    ],
    descendants: [
      {
        id: 'child',
        parentId: 'focal',
        rootId: 'root',
        depth: 1,
        authorUserId: 'u-child',
        authorUsername: 'childguy',
        authorDisplayName: 'Child Guy',
        body: 'a reply',
        createdAt: new Date('2026-01-02T00:00:00Z'),
        editedAt: null,
        checkinPrompt: null,
        isMarv: false,
        media: [],
        poll: null,
      },
    ],
    totalDescendants: 1,
    rootId: 'root',
  };
}

function makeService(opts?: {
  enabled?: boolean;
  premium?: boolean;
  disabledByAdmin?: boolean;
  preferredMode?: string;
  cached?: MarvinCatchUpDto | null;
  credits?: number;
  cost?: number;
  aiConfigured?: boolean;
  aiText?: string;
  context?: ReturnType<typeof makeContext>;
  imagesAttached?: number;
  webSearchCount?: number;
  urlFetchCount?: number;
}) {
  const prisma: any = {
    user: {
      findUnique: jest.fn(async () => ({ premium: opts?.premium ?? true, premiumPlus: false })),
    },
    marvinUserSettings: {
      findUnique: jest.fn(async () => ({
        disabledByAdmin: opts?.disabledByAdmin ?? false,
        preferredMode: opts?.preferredMode ?? 'auto',
      })),
    },
  };
  const appConfig: any = {
    marvBot: jest.fn(() => ({ enabled: opts?.enabled ?? true })),
    marvOpenAI: jest.fn(() => ({
      webSearchEnabled: true,
      webSearchModes: ['regular', 'smart'],
      visionEnabled: true,
      visionModes: ['fast', 'regular', 'smart'],
      visionMaxImagesPerTurn: 3,
    })),
    r2: jest.fn(() => ({ publicBaseUrl: 'https://cdn.test' })),
    marvCredits: jest.fn(() => ({
      fastCost: 1,
      regularCost: 2,
      smartCost: 4,
      webSearchCreditCost: 3,
      urlFetchCreditCost: 1,
      visionCreditCostPerImage: 1,
      maxCredits: 1500,
      creditsPerDay: 40,
    })),
  };
  const cache: any = {
    getJson: jest.fn(async () => opts?.cached ?? null),
    setJson: jest.fn(async () => undefined),
    withLock: jest.fn(async (_key: string, _opts: any, fn: () => Promise<any>) => fn()),
  };
  const posts: any = {
    getById: jest.fn(async () => ({ id: 'focal', rootId: 'root', createdAt: new Date('2026-01-01T00:00:00Z') })),
  };
  const context: any = {
    collect: jest.fn(async () => opts?.context ?? makeContext()),
    // Delegate image selection to the real (pure) implementation shared with the reply path.
    selectImageMedia: (ctx: any, o: any) =>
      new MarvinThreadContextService({} as any, {} as any).selectImageMedia(ctx, o),
  };
  const routing: any = {
    resolve: jest.fn(() => ({ mode: 'regular', reason: 'auto_routed', crisisDetected: false, webSearchDemanded: false })),
    estimateTokens: jest.fn(() => 100),
  };
  const ai: any = {
    isConfigured: jest.fn(() => opts?.aiConfigured !== false),
    modelForMode: jest.fn(() => 'gpt-test'),
    respond: jest.fn(async () => ({
      text: opts?.aiText ?? 'Here is what happened in the thread.',
      modelUsed: 'gpt-test',
      responseId: 'resp-1',
      inputTokens: 100,
      outputTokens: 40,
      cachedInputTokens: 0,
      estimatedCostUsd: 0.001,
      toolCallCount: 0,
      webSearchCount: opts?.webSearchCount ?? 0,
      urlFetchCount: opts?.urlFetchCount ?? 0,
      imagesAttached: opts?.imagesAttached ?? 0,
    })),
  };
  const credits: any = {
    costForMode: jest.fn(() => opts?.cost ?? 2),
    refill: jest.fn(async () => ({
      credits: opts?.credits ?? 100,
      maxCredits: 1500,
      creditsPerDay: 40,
      lastRefilledAt: new Date(),
    })),
    spend: jest.fn(async () => ({
      credits: (opts?.credits ?? 100) - (opts?.cost ?? 2),
      maxCredits: 1500,
      creditsPerDay: 40,
      lastRefilledAt: new Date(),
    })),
  };
  const usage: any = { recordEvent: jest.fn(async () => undefined) };
  const threadSummary: any = { getSummaryText: jest.fn(async () => null) };
  const tools: any = { dispatch: jest.fn(async () => '{}') };
  const linkMetadata: any = { previewLinks: jest.fn(async () => []) };

  const service = new MarvinCatchUpService(
    prisma, appConfig, cache, posts, context, routing, ai, credits, usage,
    threadSummary, tools, linkMetadata,
  );
  return { service, prisma, appConfig, cache, posts, context, routing, ai, credits, usage, threadSummary, tools, linkMetadata };
}

describe('MarvinCatchUpService', () => {
  it('returns a cached summary without calling the model or spending credits', async () => {
    const cached: MarvinCatchUpDto = {
      postId: 'focal',
      rootPostId: 'root',
      summary: 'cached summary',
      effectiveMode: 'regular',
      creditsSpent: 2,
      costBreakdown: { mode: 2, vision: 0, webSearch: 0, urlFetch: 0 },
      cached: false,
      included: { ancestors: 1, descendants: 1, totalDescendants: 1 },
      generatedAt: '2026-01-01T00:00:00.000Z',
    };
    const { service, ai, credits } = makeService({ cached });
    const result = await service.catchUp({ userId: 'u-1', postId: 'focal' });
    expect(result.summary).toBe('cached summary');
    expect(result.cached).toBe(true);
    expect(result.creditsSpent).toBe(0);
    expect(ai.respond).not.toHaveBeenCalled();
    expect(credits.spend).not.toHaveBeenCalled();
  });

  it('forceRefresh skips the cache read and regenerates (spending credits)', async () => {
    const cached: MarvinCatchUpDto = {
      postId: 'focal',
      rootPostId: 'root',
      summary: 'stale cached summary',
      effectiveMode: 'regular',
      creditsSpent: 2,
      costBreakdown: { mode: 2, vision: 0, webSearch: 0, urlFetch: 0 },
      cached: false,
      included: { ancestors: 1, descendants: 1, totalDescendants: 1 },
      generatedAt: '2026-01-01T00:00:00.000Z',
    };
    const { service, ai, credits, cache } = makeService({ cached });
    const result = await service.catchUp({ userId: 'u-1', postId: 'focal', forceRefresh: true });
    expect(cache.getJson).not.toHaveBeenCalled();
    expect(ai.respond).toHaveBeenCalledTimes(1);
    expect(credits.spend).toHaveBeenCalledTimes(1);
    expect(result.cached).toBe(false);
    expect(result.summary).not.toBe('stale cached summary');
  });

  it('rejects non-premium users', async () => {
    const { service, ai } = makeService({ premium: false });
    await expect(service.catchUp({ userId: 'u-1', postId: 'focal' })).rejects.toBeInstanceOf(ForbiddenException);
    expect(ai.respond).not.toHaveBeenCalled();
  });

  it('rejects when Marv is disabled', async () => {
    const { service } = makeService({ enabled: false });
    await expect(service.catchUp({ userId: 'u-1', postId: 'focal' })).rejects.toBeInstanceOf(ForbiddenException);
  });

  it('rejects out-of-credits before spending', async () => {
    const { service, credits, ai } = makeService({ credits: 0, cost: 2 });
    await expect(service.catchUp({ userId: 'u-1', postId: 'focal' })).rejects.toBeInstanceOf(HttpException);
    expect(credits.spend).not.toHaveBeenCalled();
    expect(ai.respond).not.toHaveBeenCalled();
  });

  it('summarizes, spends credits, and records usage on the happy path', async () => {
    const { service, ai, credits, usage, cache } = makeService();
    const result = await service.catchUp({ userId: 'u-1', postId: 'focal', requestedMode: 'regular' });
    expect(ai.respond).toHaveBeenCalledTimes(1);
    // A thread summary must synthesize, not narrate post-by-post.
    expect(ai.respond.mock.calls[0][0].developerNote).toContain('SYNTHESIZE');
    expect(credits.spend).toHaveBeenCalledTimes(1);
    expect(result.cached).toBe(false);
    expect(result.creditsSpent).toBe(2);
    expect(result.summary).toContain('thread');
    expect(result.included).toEqual({ ancestors: 1, descendants: 1, totalDescendants: 1 });
    // Usage event carries the post-spend summary so credits emit happens.
    const recorded = usage.recordEvent.mock.calls[0][0];
    expect(recorded.source).toBe('catch_up');
    expect(recorded.postSpendSummary).toBeTruthy();
    // Result is cached for the next viewer.
    expect(cache.setJson).toHaveBeenCalledTimes(1);
  });

  it('attaches images from across the conversation so Marv can see them', async () => {
    const withMedia = makeContext();
    withMedia.focal.media = [{ kind: 'image', source: 'upload', r2Key: 'posts/a.jpg', url: null }] as any;
    (withMedia.descendants[0] as any).media = [
      { kind: 'gif', source: 'giphy', r2Key: null, url: 'https://giphy.test/x.gif' },
    ];
    const { service, ai } = makeService({ context: withMedia });
    await service.catchUp({ userId: 'u-1', postId: 'focal', requestedMode: 'regular' });

    const aiArgs = ai.respond.mock.calls[0][0];
    expect(aiArgs.imageUrls).toEqual(
      expect.arrayContaining(['https://cdn.test/posts/a.jpg', 'https://giphy.test/x.gif']),
    );
    // The prompt must direct Marv to actually describe the image, not just summarize text.
    expect(aiArgs.developerNote).toContain('describe what they actually show');
    // And the rendered context notes the attachment so non-vision summaries still acknowledge it.
    expect(aiArgs.developerNote).toContain('[attached:');
  });

  it('upgrades to a vision-capable tier when the routed tier cannot see the attached image', async () => {
    const withMedia = makeContext();
    withMedia.focal.media = [{ kind: 'image', source: 'upload', r2Key: 'posts/a.jpg', url: null }] as any;
    const { service, ai, appConfig, routing } = makeService({ context: withMedia });
    // Routing picks fast, but this deployment only enables vision on regular/smart.
    routing.resolve.mockReturnValue({ mode: 'fast', reason: 'auto_routed', crisisDetected: false, webSearchDemanded: false });
    appConfig.marvOpenAI.mockReturnValue({
      webSearchEnabled: true,
      webSearchModes: ['regular', 'smart'],
      visionEnabled: true,
      visionModes: ['regular', 'smart'],
      visionMaxImagesPerTurn: 3,
    });
    await service.catchUp({ userId: 'u-1', postId: 'focal', requestedMode: 'auto' });

    const aiArgs = ai.respond.mock.calls[0][0];
    // Upgraded fast → regular (cheapest vision tier) and the image was attached.
    expect(aiArgs.mode).toBe('regular');
    expect(aiArgs.imageUrls).toEqual(['https://cdn.test/posts/a.jpg']);
  });

  it('omits images when vision is disabled', async () => {
    const withMedia = makeContext();
    withMedia.focal.media = [{ kind: 'image', source: 'upload', r2Key: 'posts/a.jpg', url: null }] as any;
    const { service, ai, appConfig } = makeService({ context: withMedia });
    appConfig.marvOpenAI.mockReturnValue({
      webSearchEnabled: true,
      webSearchModes: ['regular', 'smart'],
      visionEnabled: false,
      visionModes: ['fast', 'regular', 'smart'],
      visionMaxImagesPerTurn: 3,
    });
    await service.catchUp({ userId: 'u-1', postId: 'focal', requestedMode: 'regular' });

    expect(ai.respond.mock.calls[0][0].imageUrls).toBeUndefined();
  });

  it('charges the vision surcharge per attached image on top of the mode cost', async () => {
    const withMedia = makeContext();
    withMedia.focal.media = [{ kind: 'image', source: 'upload', r2Key: 'posts/a.jpg', url: null }] as any;
    // base mode cost = 2; AI confirms it sent 2 images; visionCreditCostPerImage = 1.
    const { service, credits } = makeService({ context: withMedia, cost: 2, imagesAttached: 2 });
    const result = await service.catchUp({ userId: 'u-1', postId: 'focal', requestedMode: 'regular' });
    expect(credits.spend).toHaveBeenCalledTimes(1);
    expect(credits.spend.mock.calls[0][1]).toBe(2 + 2 * 1); // mode + vision surcharge
    expect(result.creditsSpent).toBe(4);
  });

  it('reserves base + vision + one web-search buffer before calling the model', async () => {
    const withMedia = makeContext();
    withMedia.focal.media = [{ kind: 'image', source: 'upload', r2Key: 'posts/a.jpg', url: null }] as any;
    // base=2, one image reserved at 1 each, web-search buffer=3 → needs 6; balance only 5.
    const { service, ai, credits } = makeService({ context: withMedia, cost: 2, credits: 5 });
    await expect(service.catchUp({ userId: 'u-1', postId: 'focal', requestedMode: 'regular' })).rejects.toBeInstanceOf(
      HttpException,
    );
    expect(ai.respond).not.toHaveBeenCalled();
    expect(credits.spend).not.toHaveBeenCalled();
  });

  it('still summarizes a lone post with no thread (post itself + broader context)', async () => {
    const loneContext = {
      ...makeContext(),
      ancestors: [],
      descendants: [],
      totalDescendants: 0,
    };
    const { service, ai } = makeService({ context: loneContext });
    const result = await service.catchUp({ userId: 'u-1', postId: 'focal', requestedMode: 'auto' });

    expect(ai.respond).toHaveBeenCalledTimes(1);
    const aiArgs = ai.respond.mock.calls[0][0];
    // The developer note must always describe the highlighted post and forbid bailing out.
    expect(aiArgs.developerNote).toContain('Highlighted post:');
    expect(aiArgs.developerNote).toContain('the focal post');
    expect(aiArgs.developerNote).toContain('Never say "nothing to summarize."');
    // Synthesize, don't narrate post-by-post.
    expect(aiArgs.developerNote).toContain('one sentence');
    // Catch-up must honor Marv's brevity discipline, not write an essay.
    expect(aiArgs.developerNote).toContain('Maximum 80 words');
    expect(result.included).toEqual({ ancestors: 0, descendants: 0, totalDescendants: 0 });
    expect(result.summary).toBeTruthy();
  });

  // ── Grounding guardrail ────────────────────────────────────────────────────

  it('includes explicit anti-fabrication grounding in every prompt', async () => {
    const { service, ai } = makeService();
    await service.catchUp({ userId: 'u-1', postId: 'focal', requestedMode: 'regular' });
    const note: string = ai.respond.mock.calls[0][0].developerNote;
    expect(note).toContain('GROUNDING:');
    expect(note).toContain('Never invent names, quotes, numbers');
    expect(note).toContain('omit it rather than guess');
    expect(note).toContain('background context, never as something said in the thread');
  });

  // ── Sections ──────────────────────────────────────────────────────────────

  it('requests two-section FORMAT when there are replies', async () => {
    const { service, ai } = makeService();
    await service.catchUp({ userId: 'u-1', postId: 'focal', requestedMode: 'regular' });
    const note: string = ai.respond.mock.calls[0][0].developerNote;
    expect(note).toContain('FORMAT:');
    expect(note).toContain('POST:');
    expect(note).toContain('REPLIES:');
  });

  it('does NOT request sections format when there are no replies', async () => {
    const loneContext = { ...makeContext(), descendants: [], totalDescendants: 0 };
    const { service, ai } = makeService({ context: loneContext });
    await service.catchUp({ userId: 'u-1', postId: 'focal', requestedMode: 'regular' });
    const note: string = ai.respond.mock.calls[0][0].developerNote;
    expect(note).not.toContain('FORMAT:');
  });

  it('parses POST:/REPLIES: markers into sections when the model follows the format', async () => {
    const { service } = makeService({
      aiText: 'POST: The post is about testing.\nREPLIES: People agreed it works.',
    });
    const result = await service.catchUp({ userId: 'u-1', postId: 'focal', requestedMode: 'regular' });
    expect(result.sections).toEqual({ post: 'The post is about testing.', replies: 'People agreed it works.' });
    expect(result.summary).toContain('The post is about testing.');
    expect(result.summary).toContain('People agreed it works.');
  });

  it('falls back to single-blob summary when the model does not follow the sections format', async () => {
    const { service } = makeService({ aiText: 'Some unformatted summary without markers.' });
    const result = await service.catchUp({ userId: 'u-1', postId: 'focal', requestedMode: 'regular' });
    expect(result.sections).toBeNull();
    expect(result.summary).toBe('Some unformatted summary without markers.');
  });

  it('returns sections=null and single-blob for lone posts (no replies)', async () => {
    const loneContext = { ...makeContext(), descendants: [], totalDescendants: 0 };
    const { service } = makeService({ context: loneContext, aiText: 'POST: just a post.' });
    const result = await service.catchUp({ userId: 'u-1', postId: 'focal', requestedMode: 'regular' });
    // No FORMAT instruction was given, so the model output is treated as a single blob.
    expect(result.sections).toBeNull();
  });

  // ── Image opt-in flag ─────────────────────────────────────────────────────

  it('skips image selection and vision costs when includeImages=false', async () => {
    const withMedia = makeContext();
    withMedia.focal.media = [{ kind: 'image', source: 'upload', r2Key: 'posts/a.jpg', url: null }] as any;
    const { service, ai, credits } = makeService({ context: withMedia, cost: 2 });
    const result = await service.catchUp({ userId: 'u-1', postId: 'focal', includeImages: false });
    expect(ai.respond.mock.calls[0][0].imageUrls).toBeUndefined();
    // No vision surcharge reserved or spent.
    expect(credits.refill).toHaveBeenCalledTimes(1);
    expect(result.costBreakdown.vision).toBe(0);
  });

  it('uses a distinct cache key for includeImages=false vs true', async () => {
    const { service, cache } = makeService({ cached: null });
    await service.catchUp({ userId: 'u-1', postId: 'focal', includeImages: true });
    const keyWithImg: string = cache.getJson.mock.calls[0][0];
    cache.getJson.mockClear();
    cache.setJson.mockClear();
    await service.catchUp({ userId: 'u-1', postId: 'focal', includeImages: false });
    const keyNoImg: string = cache.getJson.mock.calls[0][0];
    expect(keyWithImg).toContain(':img:');
    expect(keyNoImg).toContain(':noimg:');
    expect(keyWithImg).not.toBe(keyNoImg);
  });

  it('peekCached honors the includeImages flag in the cache key', async () => {
    const cached: MarvinCatchUpDto = {
      postId: 'focal',
      rootPostId: 'root',
      summary: 'peeked',
      effectiveMode: 'regular',
      creditsSpent: 2,
      costBreakdown: { mode: 2, vision: 0, webSearch: 0, urlFetch: 0 },
      cached: false,
      included: { ancestors: 1, descendants: 1, totalDescendants: 1 },
      generatedAt: '2026-01-01T00:00:00.000Z',
    };
    const { service, cache } = makeService({ cached });
    await service.peekCached({ userId: 'u-1', postId: 'focal', includeImages: false });
    const key: string = cache.getJson.mock.calls[0][0];
    expect(key).toContain(':noimg:');
  });
});

describe('MarvinCatchUpService.peekCached', () => {
  it('returns the cached summary (free) without calling the model when a cache entry exists', async () => {
    const cached: MarvinCatchUpDto = {
      postId: 'focal',
      rootPostId: 'root',
      summary: 'cached peek summary',
      effectiveMode: 'regular',
      creditsSpent: 2,
      costBreakdown: { mode: 2, vision: 0, webSearch: 0, urlFetch: 0 },
      cached: false,
      included: { ancestors: 1, descendants: 1, totalDescendants: 1 },
      generatedAt: '2026-01-01T00:00:00.000Z',
    };
    const { service, ai, credits } = makeService({ cached });
    const result = await service.peekCached({ userId: 'u-1', postId: 'focal' });
    expect(result).not.toBeNull();
    expect(result?.summary).toBe('cached peek summary');
    expect(result?.cached).toBe(true);
    expect(result?.creditsSpent).toBe(0);
    expect(result?.costBreakdown).toEqual({ mode: 0, vision: 0, webSearch: 0, urlFetch: 0 });
    // A peek must NEVER call the model or spend credits.
    expect(ai.respond).not.toHaveBeenCalled();
    expect(credits.spend).not.toHaveBeenCalled();
  });

  it('returns null on a cache miss without generating or spending', async () => {
    const { service, ai, credits } = makeService({ cached: null });
    const result = await service.peekCached({ userId: 'u-1', postId: 'focal' });
    expect(result).toBeNull();
    expect(ai.respond).not.toHaveBeenCalled();
    expect(credits.spend).not.toHaveBeenCalled();
  });

  it('returns null (never throws) for non-premium users', async () => {
    const { service, ai } = makeService({ premium: false, cached: null });
    await expect(service.peekCached({ userId: 'u-1', postId: 'focal' })).resolves.toBeNull();
    expect(ai.respond).not.toHaveBeenCalled();
  });

  it('returns null (never throws) when Marv is disabled', async () => {
    const { service } = makeService({ enabled: false, cached: null });
    await expect(service.peekCached({ userId: 'u-1', postId: 'focal' })).resolves.toBeNull();
  });
});
