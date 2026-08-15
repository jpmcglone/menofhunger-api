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
 */

function makeService(opts?: {
  aiText?: string | null;
  aiConfigured?: boolean;
  publicPosts?: Array<{ body: string; media?: any[]; poll?: any }>;
  publicArticles?: Array<{ title: string; excerpt?: string }>;
  existingCard?: { cardText: string; source: string; updatedAt: Date } | null;
  interests?: string[];
}) {
  const findManyPosts = jest.fn(async (_args: any) => {
    return (opts?.publicPosts ?? []).map((p, i) => ({
      body: p.body,
      createdAt: new Date(2026, 0, i + 1),
      media: p.media ?? [],
      poll: p.poll ?? null,
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
    $queryRaw: jest.fn(async () => []),
    user: {
      findUnique: jest.fn(async ({ where }: any) => {
        if (where.id === 'banned-user') return null;
        if (where.id === 'bot-user') {
          return baseUser({ id: 'bot-user', isBot: true });
        }
        return baseUser({ id: where.id, interests: opts?.interests ?? ['woodworking'] });
      }),
      findFirst: jest.fn(async () => baseUser({ id: 'u-1', username: 'alice' })),
      findMany: jest.fn(async () => []),
    },
    post: { findMany: findManyPosts },
    article: { findMany: findManyArticles },
    follow: { count: jest.fn(async () => 0) },
    userContextCard: {
      findUnique: jest.fn(async () => opts?.existingCard ?? null),
      upsert: jest.fn(async ({ create, update }: any) => {
        if (update && Object.keys(update).length > 0) return update;
        return { ...create, updatedAt: new Date('2026-02-01T00:00:00Z') };
      }),
    },
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

  const appConfig: any = {
    marvOpenAI: () => ({
      visionEnabled: true,
      visionModes: ['fast', 'regular', 'smart'],
      visionMaxImagesPerTurn: 4,
    }),
    r2: () => ({ publicBaseUrl: 'https://cdn.test' }),
  };

  const linkMetadata: any = { previewLinks: jest.fn(async () => []) };

  return {
    service: new MarvinContextCardService(prisma, ai, appConfig, linkMetadata),
    prisma,
    ai,
    findManyPosts,
    findManyArticles,
    linkMetadata,
  };
}

function baseUser(overrides: Record<string, any>) {
  return {
    id: 'u-1',
    username: 'alice',
    name: 'Alice',
    bio: 'Reader.',
    interests: [],
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
      communityGroupId: null,
    });
    expect(args.take).toBe(12);
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
    const aiCall = m.ai.respond.mock.calls[0]![0];
    expect(aiCall.userMessage).toContain('Faith & Fasting');
  });

  it('includes interests in the AI prompt', async () => {
    const m = makeService({ interests: ['woodworking', 'scripture'] });
    await m.service.refreshCardForUser('u-1');
    const aiCall = m.ai.respond.mock.calls[0]![0];
    expect(aiCall.userMessage).toContain('woodworking');
    expect(aiCall.userMessage).toContain('scripture');
  });

  it('folds new posts into the existing card instead of starting from scratch', async () => {
    const m = makeService({
      existingCard: {
        cardText: 'Alice writes about books.',
        source: 'generated',
        updatedAt: new Date('2026-01-01T00:00:00Z'),
      },
      publicPosts: [{ body: 'Just finished a walnut bench.' }],
      aiText: 'Alice writes about books and lately has been posting shop projects, including a walnut bench.',
    });
    const result = await m.service.refreshCardForUser('u-1');
    const postArgs = m.findManyPosts.mock.calls[0]![0];
    expect(postArgs.where.createdAt).toEqual({ gt: new Date('2026-01-01T00:00:00Z') });
    const aiCall = m.ai.respond.mock.calls[0]![0];
    expect(aiCall.userMessage).toContain('Existing card:');
    expect(aiCall.userMessage).toContain('Alice writes about books.');
    expect(aiCall.userMessage).toContain('New public posts');
    expect(aiCall.developerNote).toMatch(/fold in the NEW public activity/i);
    expect(result).toMatch(/walnut bench/i);
  });

  it('skips the model when an existing card has no new public activity', async () => {
    const m = makeService({
      existingCard: {
        cardText: 'Alice writes about books.',
        source: 'generated',
        updatedAt: new Date('2026-01-01T00:00:00Z'),
      },
      publicPosts: [],
    });
    const result = await m.service.refreshCardForUser('u-1');
    expect(result).toBe('Alice writes about books.');
    expect(m.ai.respond).not.toHaveBeenCalled();
    expect(m.prisma.userContextCard.upsert).not.toHaveBeenCalled();
  });

  it('forceFull rebuilds even when nothing new has landed', async () => {
    const m = makeService({
      existingCard: {
        cardText: 'Alice writes about books.',
        source: 'generated',
        updatedAt: new Date('2026-01-01T00:00:00Z'),
      },
      publicPosts: [{ body: 'An older post.' }],
    });
    await m.service.refreshCardForUser('u-1', { forceFull: true });
    const postArgs = m.findManyPosts.mock.calls[0]![0];
    expect(postArgs.where.createdAt).toBeUndefined();
    expect(m.ai.respond).toHaveBeenCalled();
  });

  it('passes post images to vision', async () => {
    const m = makeService({
      publicPosts: [{
        body: 'Shop day.',
        media: [{ kind: 'image', source: 'upload', r2Key: 'posts/bench.jpg', url: null, thumbnailR2Key: null }],
      }],
    });
    await m.service.refreshCardForUser('u-1');
    const aiCall = m.ai.respond.mock.calls[0]![0];
    expect(aiCall.imageUrls).toEqual(['https://cdn.test/posts/bench.jpg']);
    expect(aiCall.userMessage).toMatch(/attached: image/i);
  });

  it('passes video posters, GIFs, polls, and link-preview images', async () => {
    const m = makeService({
      publicPosts: [{
        body: 'Vote and watch https://example.com/build',
        media: [
          { kind: 'video', source: 'upload', r2Key: 'posts/clip.mp4', url: null, thumbnailR2Key: 'posts/clip.jpg' },
          { kind: 'gif', source: 'giphy', r2Key: null, url: 'https://giphy.test/x.gif', thumbnailR2Key: null },
        ],
        poll: {
          totalVoteCount: 3,
          endsAt: null,
          options: [{ text: 'Walnut', voteCount: 2 }, { text: 'Oak', voteCount: 1 }],
        },
      }],
    });
    m.linkMetadata.previewLinks.mockResolvedValueOnce([
      { url: 'https://example.com/build', title: 'Build log', description: 'A bench.', siteName: 'Example', imageUrl: 'https://og.test/bench.jpg' },
    ]);
    await m.service.refreshCardForUser('u-1');
    const aiCall = m.ai.respond.mock.calls[0]![0];
    expect(aiCall.imageUrls).toEqual([
      'https://cdn.test/posts/clip.jpg',
      'https://giphy.test/x.gif',
      'https://og.test/bench.jpg',
    ]);
    expect(aiCall.userMessage).toMatch(/attached: animated GIF \+ video/i);
    expect(aiCall.userMessage).toContain('[poll: Walnut (2), Oak (1)]');
    expect(aiCall.userMessage).toContain('[preview image attached]');
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
    expect(result).toMatch(/books/i);
    expect(result).toMatch(/hiking/i);
  });

  it('caps card text length and produces a fallback when AI returns empty', async () => {
    const m = makeService({ aiText: '' });
    const result = await m.service.refreshCardForUser('u-1');
    expect(result).not.toBeNull();
    expect(result!.length).toBeLessThanOrEqual(1200);
    expect(result!.toLowerCase()).toContain('alice');
  });

  it('falls back deterministically when the AI is not configured', async () => {
    const m = makeService({ aiConfigured: false, interests: ['woodworking'] });
    const result = await m.service.refreshCardForUser('u-1');
    expect(m.ai.respond).not.toHaveBeenCalled();
    expect(result).not.toBeNull();
    expect(result!.toLowerCase()).toContain('alice');
    expect(result).toMatch(/woodworking/i);
  });
});

describe('MarvinContextCardService — getCardText', () => {
  it('returns null when the username is empty', async () => {
    const m = makeService();
    const result = await m.service.getCardText('   ');
    expect(result).toBeNull();
  });
});

describe('MarvinContextCardService — peekFallbackCard', () => {
  it('returns a profile-only card without calling the model', async () => {
    const m = makeService({ interests: ['woodworking'] });
    const result = await m.service.peekFallbackCard('u-1');
    expect(result).toMatch(/alice/i);
    expect(result).toMatch(/woodworking/i);
    expect(m.ai.respond).not.toHaveBeenCalled();
    expect(m.prisma.userContextCard.upsert).not.toHaveBeenCalled();
  });

  it('includes recent public post snippets so Marv can answer before a generated card exists', async () => {
    const m = makeService({
      publicPosts: [{ body: 'Just finished a walnut bench.' }, { body: 'Fasting Wednesday.' }],
    });
    const result = await m.service.peekFallbackCard('u-1');
    expect(result).toMatch(/walnut bench/i);
    expect(result).toMatch(/Fasting Wednesday/i);
    expect(m.ai.respond).not.toHaveBeenCalled();
  });
});

describe('MarvinContextCardService — ensureLiveCard', () => {
  it('returns the persisted card when one exists', async () => {
    const m = makeService({
      existingCard: {
        cardText: 'Alice writes about books.',
        source: 'generated',
        updatedAt: new Date('2026-01-01T00:00:00Z'),
      },
    });
    const result = await m.service.ensureLiveCard('alice');
    expect(result).toMatchObject({
      userId: 'u-1',
      username: 'alice',
      cardText: 'Alice writes about books.',
      source: 'generated',
    });
    expect(m.prisma.userContextCard.upsert).not.toHaveBeenCalled();
    expect(m.ai.respond).not.toHaveBeenCalled();
  });

  it('persists a live fallback when no card exists yet', async () => {
    const m = makeService({ interests: ['woodworking'], publicPosts: [{ body: 'Shop day.' }] });
    const result = await m.service.ensureLiveCard('alice');
    expect(result?.source).toBe('fallback');
    expect(result?.cardText).toMatch(/alice/i);
    expect(result?.cardText).toMatch(/Shop day/i);
    expect(m.prisma.userContextCard.upsert).toHaveBeenCalledWith(
      expect.objectContaining({
        create: expect.objectContaining({ userId: 'u-1', source: 'fallback' }),
      }),
    );
    expect(m.ai.respond).not.toHaveBeenCalled();
  });

  it('returns null for an empty username', async () => {
    const m = makeService();
    expect(await m.service.ensureLiveCard('   ')).toBeNull();
  });
});
