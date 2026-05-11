import { MarvinContextCardService } from './marvin-context-card.service';

/**
 * Safety-focused unit tests for the Marv context card pipeline.
 *
 * The card text is one of two things Marv reads about a user (along with the
 * Bio they wrote themselves), so it MUST NOT leak:
 *  - direct messages
 *  - posts marked `onlyMe`, `verifiedOnly`, or `premiumOnly`
 *  - emails / phone numbers
 *  - sentences containing crisis / medical vocabulary
 *
 * These tests exercise the redaction + visibility filters; they do not assert
 * the exact wording of generated cards (that's an integration concern).
 */

function makeService(opts?: {
  aiText?: string | null;
  aiConfigured?: boolean;
  /** Posts the Prisma mock should return for findMany. The test asserts on the where-clause. */
  publicPosts?: Array<{ body: string }>;
  publicArticles?: Array<{ title: string; excerpt?: string }>;
}) {
  const findManyPosts = jest.fn(async (_args: any) => {
    return (opts?.publicPosts ?? []).map((p, i) => ({
      body: p.body,
      createdAt: new Date(2026, 0, i + 1),
    }));
  });

  const findManyArticles = jest.fn(async (_args: any) => {
    return (opts?.publicArticles ?? []).map((a, i) => ({
      title: a.title,
      excerpt: a.excerpt ?? null,
      publishedAt: new Date(2026, 0, i + 1),
    }));
  });

  const prisma: any = {
    user: {
      findUnique: jest.fn(async ({ where }: any) => {
        if (where.id === 'banned-user') return null;
        if (where.id === 'bot-user') {
          return baseUser({ id: 'bot-user', isBot: true });
        }
        return baseUser({ id: where.id });
      }),
      findFirst: jest.fn(async () => baseUser({ id: 'u-1', username: 'alice' })),
      findMany: jest.fn(async () => []),
    },
    post: { findMany: findManyPosts },
    article: { findMany: findManyArticles },
    follow: { count: jest.fn(async () => 0) },
    userContextCard: {
      findUnique: jest.fn(async () => null),
      upsert: jest.fn(async ({ create }: any) => create),
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
  };

  const ai: any = {
    isConfigured: jest.fn(() => opts?.aiConfigured !== false),
    respond: jest.fn(async () => ({
      text: opts?.aiText ?? 'Alice posts about books and faith.',
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
    service: new MarvinContextCardService(prisma, ai),
    prisma,
    ai,
    findManyPosts,
    findManyArticles,
  };
}

function baseUser(overrides: Record<string, any>) {
  return {
    id: 'u-1',
    username: 'alice',
    name: 'Alice',
    bio: 'Reader.',
    premium: false,
    premiumPlus: false,
    isOrganization: false,
    verifiedStatus: 'unverified',
    createdAt: new Date(2025, 0, 1),
    isBot: false,
    ...overrides,
  };
}

describe('MarvinContextCardService — refreshCardForUser', () => {
  it('only reads PUBLIC posts (not onlyMe / verifiedOnly / premiumOnly / DMs)', async () => {
    const m = makeService();
    await m.service.refreshCardForUser('u-1');
    expect(m.findManyPosts).toHaveBeenCalledTimes(1);
    const args = m.findManyPosts.mock.calls[0]![0];
    expect(args.where).toMatchObject({
      userId: 'u-1',
      deletedAt: null,
      visibility: 'public',
    });
  });

  it('queries public published articles with the correct filter', async () => {
    const m = makeService({ publicArticles: [{ title: 'Faith & Fasting', excerpt: 'A reflection on the discipline of fasting.' }] });
    await m.service.refreshCardForUser('u-1');
    expect(m.findManyArticles).toHaveBeenCalledTimes(1);
    const args = m.findManyArticles.mock.calls[0]![0];
    expect(args.where).toMatchObject({
      authorId: 'u-1',
      deletedAt: null,
      isDraft: false,
      visibility: 'public',
    });
    // Article title should be passed into the AI prompt.
    const aiCall = m.ai.respond.mock.calls[0]![0];
    expect(aiCall.userMessage).toContain('Faith & Fasting');
  });

  it('skips bot accounts entirely (no AI call, no upsert)', async () => {
    const m = makeService();
    const result = await m.service.refreshCardForUser('bot-user');
    expect(result).toBeNull();
    expect(m.ai.respond).not.toHaveBeenCalled();
    expect(m.prisma.userContextCard.upsert).not.toHaveBeenCalled();
  });

  it('redacts emails and phone-like sequences from the generated card', async () => {
    const m = makeService({
      aiText:
        'Alice writes thoughtful posts. Reach her at alice@example.com or +1 (415) 555-0199 for anything.',
    });
    const result = await m.service.refreshCardForUser('u-1');
    expect(result).not.toBeNull();
    expect(result).not.toMatch(/@example\.com/i);
    expect(result).not.toMatch(/415/);
    // The redaction marker should appear at least once.
    expect(result).toContain('[redacted]');
  });

  it('strips sentences containing sensitive medical / crisis terms', async () => {
    const m = makeService({
      aiText:
        'Alice posts about books. She mentioned her medication for depression. She also enjoys hiking.',
    });
    const result = await m.service.refreshCardForUser('u-1');
    expect(result).not.toBeNull();
    expect(result).not.toMatch(/medication/i);
    expect(result).not.toMatch(/depress/i);
    // Non-sensitive content is preserved.
    expect(result).toMatch(/books/i);
    expect(result).toMatch(/hiking/i);
  });

  it('caps card text length and produces a fallback when AI returns empty', async () => {
    const m = makeService({ aiText: '' });
    const result = await m.service.refreshCardForUser('u-1');
    expect(result).not.toBeNull();
    expect(result!.length).toBeLessThanOrEqual(800);
    // Fallback names the user.
    expect(result!.toLowerCase()).toContain('alice');
  });

  it('falls back deterministically when the AI is not configured', async () => {
    const m = makeService({ aiConfigured: false });
    const result = await m.service.refreshCardForUser('u-1');
    expect(m.ai.respond).not.toHaveBeenCalled();
    expect(result).not.toBeNull();
    expect(result!.toLowerCase()).toContain('alice');
  });
});

describe('MarvinContextCardService — getCardText', () => {
  it('returns null when the username is empty', async () => {
    const m = makeService();
    const result = await m.service.getCardText('   ');
    expect(result).toBeNull();
  });
});
