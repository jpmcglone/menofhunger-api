import { MarvinThreadSummaryService } from './marvin-thread-summary.service';

/**
 * MarvinThreadSummaryService keeps a per-thread rolling summary fresh.
 * Two invariants matter:
 *  1. Without new posts since the last successful run, it's a no-op (no AI call,
 *     no DB write that bumps timestamps).
 *  2. With new posts, it composes a fresh summary AND advances
 *     `lastMessageIdIncluded` so subsequent runs incrementally pick up where
 *     this one left off.
 */

function makeService(opts?: {
  existingSummary?: { summary: string; lastMessageIdIncluded: string | null } | null;
  /** Posts returned for the "new since" query. */
  newPosts?: Array<{ id: string; body: string; createdAt: Date; username: string | null }>;
  aiConfigured?: boolean;
  aiText?: string;
}) {
  const findUniqueSummary = jest.fn(async () => opts?.existingSummary ?? null);
  const findUniquePost = jest.fn(async ({ where }: any) => {
    // Used to resolve the createdAt floor for `lastMessageIdIncluded`.
    if (where.id === 'm-3') return { createdAt: new Date(2026, 0, 3) };
    return null;
  });
  const findManyPosts = jest.fn(async () =>
    (opts?.newPosts ?? []).map((p) => ({
      id: p.id,
      body: p.body,
      createdAt: p.createdAt,
      user: { username: p.username },
    })),
  );
  const upsertSummary = jest.fn(async ({ create }: any) => create);
  const countPosts = jest.fn(async () => 0);

  const prisma: any = {
    marvinThreadSummary: {
      findUnique: findUniqueSummary,
      upsert: upsertSummary,
    },
    post: {
      findUnique: findUniquePost,
      findMany: findManyPosts,
      count: countPosts,
    },
  };

  const ai: any = {
    isConfigured: jest.fn(() => opts?.aiConfigured !== false),
    respond: jest.fn(async () => ({
      text: opts?.aiText ?? 'New rolling summary.',
      modelUsed: 'gpt-test',
      responseId: 'r1',
      inputTokens: 100,
      outputTokens: 30,
      cachedInputTokens: 0,
      estimatedCostUsd: 0,
      toolCallCount: 0,
    })),
  };

  return {
    service: new MarvinThreadSummaryService(prisma, ai),
    findUniqueSummary,
    findManyPosts,
    upsertSummary,
    countPosts,
    ai,
  };
}

describe('MarvinThreadSummaryService.shouldSummarize', () => {
  it('returns false for an empty rootPostId', async () => {
    const m = makeService();
    expect(await m.service.shouldSummarize('')).toBe(false);
  });

  it('triggers once the reply count meets the threshold', async () => {
    const m = makeService();
    m.countPosts.mockResolvedValueOnce(20);
    expect(await m.service.shouldSummarize('r-1')).toBe(true);
  });

  it("doesn't trigger below the threshold", async () => {
    const m = makeService();
    m.countPosts.mockResolvedValueOnce(19);
    expect(await m.service.shouldSummarize('r-1')).toBe(false);
  });
});

describe('MarvinThreadSummaryService.summarizeThread', () => {
  it('no-ops when there are no new posts since the last summary', async () => {
    const m = makeService({
      existingSummary: { summary: 'Existing summary.', lastMessageIdIncluded: 'm-3' },
      newPosts: [],
    });
    const result = await m.service.summarizeThread('r-1');
    expect(result).toBe('Existing summary.');
    expect(m.ai.respond).not.toHaveBeenCalled();
    expect(m.upsertSummary).not.toHaveBeenCalled();
  });

  it('composes a new summary and advances lastMessageIdIncluded', async () => {
    const m = makeService({
      existingSummary: { summary: 'Old summary.', lastMessageIdIncluded: 'm-3' },
      newPosts: [
        {
          id: 'm-4',
          body: 'A new reply about hope.',
          createdAt: new Date(2026, 0, 4),
          username: 'alice',
        },
        {
          id: 'm-5',
          body: 'Another reply about faith.',
          createdAt: new Date(2026, 0, 5),
          username: 'bob',
        },
      ],
      aiText: 'Updated summary integrating hope and faith.',
    });
    const result = await m.service.summarizeThread('r-1');
    expect(result).toBe('Updated summary integrating hope and faith.');
    expect(m.upsertSummary).toHaveBeenCalledTimes(1);
    const call = m.upsertSummary.mock.calls[0]![0];
    expect(call.create.lastMessageIdIncluded).toBe('m-5');
    expect(call.create.summary).toBe('Updated summary integrating hope and faith.');
  });

  it('falls back to deterministic concatenation when AI is unavailable', async () => {
    const m = makeService({
      existingSummary: null,
      newPosts: [
        {
          id: 'm-1',
          body: 'First reply.',
          createdAt: new Date(2026, 0, 1),
          username: 'alice',
        },
      ],
      aiConfigured: false,
    });
    const result = await m.service.summarizeThread('r-1');
    expect(result).toContain('First reply.');
    expect(m.ai.respond).not.toHaveBeenCalled();
    // Even without AI, the new lastMessageIdIncluded gets persisted.
    const call = m.upsertSummary.mock.calls[0]![0];
    expect(call.create.lastMessageIdIncluded).toBe('m-1');
  });

  it('returns null when nothing existed and there are no new posts (AI not configured)', async () => {
    const m = makeService({ existingSummary: null, newPosts: [], aiConfigured: false });
    const result = await m.service.summarizeThread('r-1');
    expect(result).toBeNull();
    expect(m.upsertSummary).not.toHaveBeenCalled();
  });
});
