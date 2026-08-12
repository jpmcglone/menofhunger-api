import { MarvinToolHandlersService } from './marvin-tool-handlers.service';
import type { MarvAIToolCallContext } from './marvin-ai.service';

/**
 * Fake CacheService that mimics `getOrSetJson` / `getOrSetNullableJson` semantics
 * with an in-memory map. Lets us assert on cache hit/miss and recompute counts
 * without spinning up Redis.
 */
function makeFakeCache() {
  const store = new Map<string, unknown>();
  let hits = 0;
  let computes = 0;

  const getOrSetJson = jest.fn(async (params: any) => {
    if (!params.enabled) {
      computes++;
      return await params.compute();
    }
    if (store.has(params.key)) {
      hits++;
      return store.get(params.key);
    }
    computes++;
    const value = await params.compute();
    store.set(params.key, value);
    return value;
  });

  const getOrSetNullableJson = jest.fn(async (params: any) => {
    if (!params.enabled) {
      computes++;
      return await params.compute();
    }
    if (store.has(params.key)) {
      hits++;
      return store.get(params.key);
    }
    computes++;
    const value = await params.compute();
    store.set(params.key, value ?? null);
    return value;
  });

  const setJson = jest.fn(async (key: string, value: unknown) => {
    store.set(key, value);
  });

  const cache: any = { getOrSetJson, getOrSetNullableJson, setJson };

  return {
    cache,
    counters: () => ({ hits, computes, size: store.size }),
    has: (key: string) => store.has(key),
    get: (key: string) => store.get(key),
  };
}

function makeService() {
  const prisma: any = {
    $queryRaw: jest.fn(async () => []),
    user: { findFirst: jest.fn() },
    userContextCard: { findFirst: jest.fn() },
    post: { findFirst: jest.fn(), findMany: jest.fn(async () => []) },
    marvinThreadSummary: { findUnique: jest.fn() },
    message: { findMany: jest.fn(async () => []) },
  };
  const identity: any = {
    getMarvUserId: jest.fn(async () => 'marv-id'),
    marvUsernameLower: jest.fn(() => 'marv'),
  };
  const fake = makeFakeCache();
  const contextCard: any = {
    refreshCardForUser: jest.fn(async () => null),
    peekFallbackCard: jest.fn(async () => 'Alice is a member on the platform.'),
  };
  const scripture: any = {
    getRef: jest.fn(async (ref: string) =>
      ref.toLowerCase().includes('john')
        ? {
            reference: 'John 3:16',
            translation: 'BSB',
            translationName: 'Berean Standard Bible',
            text: 'For God so loved the world...',
            verses: [{ number: 16, text: 'For God so loved the world...' }],
          }
        : null,
    ),
  };
  const jobs: any = { enqueue: jest.fn(async () => undefined) };
  const svc = new MarvinToolHandlersService(prisma, identity, fake.cache, contextCard, scripture, jobs);
  return { svc, prisma, identity, cache: fake, contextCard, scripture, jobs };
}

const baseCtx: MarvAIToolCallContext = {
  rootPostId: 'r-1',
  triggeringPostId: 'p-1',
  requesterUserId: 'u-1',
};

describe('MarvinToolHandlersService.dispatch', () => {
  it('returns unknown_tool for unknown names', async () => {
    const { svc } = makeService();
    const out = await svc.dispatch('not_a_real_tool', {}, baseCtx);
    expect(JSON.parse(out)).toEqual({ error: 'unknown_tool', name: 'not_a_real_tool' });
  });

  describe('get_user_basic_info', () => {
    // The SQL query in get_user_basic_info enforces `bannedAt IS NULL`, so a banned user
    // returns no rows -> `user_not_found`. Non-banned users are looked up freely.
    it('returns user_not_found when the SQL layer filters the user (e.g. banned or missing)', async () => {
      const { svc, prisma } = makeService();
      prisma.$queryRaw.mockResolvedValueOnce([]);
      const out = await svc.dispatch('get_user_basic_info', { username: 'eve' }, baseCtx);
      expect(JSON.parse(out)).toEqual({ error: 'user_not_found' });
    });

    it('returns the user record (case-insensitive username match)', async () => {
      const { svc, prisma } = makeService();
      prisma.$queryRaw.mockResolvedValueOnce([
        {
          id: 'a-1',
          username: 'Alice',
          name: 'Alice X',
          premium: true,
          premiumPlus: false,
          verifiedStatus: 'manual',
          createdAt: new Date('2026-01-01T00:00:00Z'),
          isBot: false,
          botType: null,
        },
      ]);
      const out = await svc.dispatch('get_user_basic_info', { username: 'ALICE' }, baseCtx);
      const parsed = JSON.parse(out);
      expect(parsed.username).toBe('Alice');
      expect(parsed.isPremium).toBe(true);
      expect(parsed.isMarv).toBe(false);
    });
  });

  describe('get_user_context_card', () => {
    it('returns no_card when no card row exists and the user cannot be resolved', async () => {
      const { svc, prisma, jobs } = makeService();
      prisma.userContextCard.findFirst.mockResolvedValueOnce(null);
      prisma.user.findFirst.mockResolvedValueOnce(null);
      const out = await svc.dispatch('get_user_context_card', { username: 'eve' }, baseCtx);
      expect(JSON.parse(out)).toEqual({ error: 'no_card', note: expect.any(String) });
      expect(jobs.enqueue).not.toHaveBeenCalled();
    });

    it('enqueues a card refresh and returns a fallback without blocking on AI', async () => {
      const { svc, prisma, jobs, contextCard } = makeService();
      prisma.userContextCard.findFirst.mockResolvedValueOnce(null);
      prisma.user.findFirst.mockResolvedValueOnce({ id: 'u-1', username: 'alice' });
      const out = await svc.dispatch('get_user_context_card', { username: 'alice' }, baseCtx);
      const parsed = JSON.parse(out);
      expect(parsed.source).toBe('fallback');
      expect(parsed.cardText).toMatch(/alice/i);
      expect(contextCard.refreshCardForUser).not.toHaveBeenCalled();
      expect(jobs.enqueue).toHaveBeenCalledWith(
        'marvin.contextCard.refresh',
        { userId: 'u-1' },
        expect.objectContaining({ jobId: 'marvin-context-card-u-1' }),
      );
    });

    it('returns the card for any non-banned user', async () => {
      const { svc, prisma } = makeService();
      prisma.userContextCard.findFirst.mockResolvedValueOnce({
        cardText: 'Alice is a long-time member.',
        source: 'generated',
        updatedAt: new Date('2026-01-01T00:00:00Z'),
        user: { username: 'alice' },
      });
      const out = await svc.dispatch('get_user_context_card', { username: 'alice' }, baseCtx);
      const parsed = JSON.parse(out);
      expect(parsed.cardText).toContain('Alice');
    });
  });

  describe('get_post_thread_recent_messages thread scoping', () => {
    it('rejects rootPostIds that differ from the request scope', async () => {
      const { svc } = makeService();
      const out = await svc.dispatch(
        'get_post_thread_recent_messages',
        { rootPostId: 'someone-else-thread' },
        baseCtx,
      );
      expect(JSON.parse(out)).toEqual({ error: 'thread_not_in_scope' });
    });
  });

  describe('get_my_recent_chat_messages requires conversationId', () => {
    it('returns no_conversation when ctx.conversationId is missing', async () => {
      const { svc } = makeService();
      const out = await svc.dispatch('get_my_recent_chat_messages', {}, baseCtx);
      expect(JSON.parse(out)).toEqual({ error: 'no_conversation' });
    });
  });

  describe('invalid args are rejected', () => {
    it('returns invalid_args for malformed inputs', async () => {
      const { svc } = makeService();
      const out = await svc.dispatch('get_user_basic_info', { username: '' }, baseCtx);
      expect(JSON.parse(out)).toEqual({ error: 'invalid_args' });
    });
  });

  describe('Redis read-through cache dedup', () => {
    it('get_user_basic_info: two consecutive calls hit Postgres once', async () => {
      const { svc, prisma, cache } = makeService();
      prisma.$queryRaw.mockResolvedValue([
        {
          id: 'a-1',
          username: 'Alice',
          name: 'Alice X',
          premium: true,
          premiumPlus: false,
          verifiedStatus: 'manual',
          createdAt: new Date('2026-01-01T00:00:00Z'),
          isBot: false,
          botType: null,
        },
      ]);
      await svc.dispatch('get_user_basic_info', { username: 'Alice' }, baseCtx);
      await svc.dispatch('get_user_basic_info', { username: 'ALICE' }, baseCtx);
      // Same username (case-insensitive) → cache key matches → exactly one DB call.
      expect(prisma.$queryRaw).toHaveBeenCalledTimes(1);
      const c = cache.counters();
      expect(c.computes).toBe(1);
      expect(c.hits).toBe(1);
    });

    it('get_post: same postId twice → one DB call', async () => {
      const { svc, prisma, cache } = makeService();
      prisma.post.findFirst.mockResolvedValue({
        id: 'p-1',
        body: 'hello',
        createdAt: new Date('2026-01-01T00:00:00Z'),
        visibility: 'public',
        rootId: 'r-1',
        parentId: null,
        user: { username: 'alice', name: 'Alice', isBot: false },
      });
      await svc.dispatch('get_post', { postId: 'p-1' }, baseCtx);
      await svc.dispatch('get_post', { postId: 'p-1' }, baseCtx);
      expect(prisma.post.findFirst).toHaveBeenCalledTimes(1);
      expect(cache.counters().hits).toBe(1);
    });

    it('get_post: refuses private-group posts unless they are in the current thread', async () => {
      const { svc, prisma } = makeService();
      prisma.post.findFirst.mockResolvedValue(null);
      await svc.dispatch('get_post', { postId: 'private-p' }, { ...baseCtx, rootPostId: undefined });
      const where = prisma.post.findFirst.mock.calls[0][0].where;
      expect(where.OR).toEqual([
        { communityGroupId: null },
        { communityGroup: { deletedAt: null, joinPolicy: 'open' } },
      ]);
      expect(where.OR).not.toContainEqual({ id: 'r-1' });
    });

    it('get_post: current-thread OR lets a private-group @marv mention still load', async () => {
      const { svc, prisma } = makeService();
      prisma.post.findFirst.mockResolvedValue({
        id: 'p-1',
        body: 'hello',
        createdAt: new Date('2026-01-01T00:00:00Z'),
        visibility: 'public',
        rootId: 'r-1',
        parentId: null,
        user: { username: 'alice', name: 'Alice', isBot: false },
      });
      await svc.dispatch('get_post', { postId: 'p-1' }, baseCtx);
      const where = prisma.post.findFirst.mock.calls[0][0].where;
      expect(where.OR).toContainEqual({ communityGroupId: null });
      expect(where.OR).toContainEqual({ id: 'r-1' });
      expect(where.OR).toContainEqual({ rootId: 'r-1' });
    });

    it('get_post_thread_recent_messages: same root + same limit → one DB pair', async () => {
      const { svc, prisma } = makeService();
      prisma.post.findFirst.mockResolvedValue({
        id: 'r-1',
        body: 'root',
        createdAt: new Date('2026-01-01T00:00:00Z'),
        user: { username: 'alice', name: 'Alice', isBot: false },
      });
      prisma.post.findMany.mockResolvedValue([]);
      await svc.dispatch('get_post_thread_recent_messages', { rootPostId: 'r-1' }, baseCtx);
      await svc.dispatch('get_post_thread_recent_messages', { rootPostId: 'r-1' }, baseCtx);
      // findFirst (root) + findMany (replies) run once total.
      expect(prisma.post.findFirst).toHaveBeenCalledTimes(1);
      expect(prisma.post.findMany).toHaveBeenCalledTimes(1);
    });
  });

  describe('Negative cache for misses', () => {
    it('get_user_context_card: missing card returns no_card and dedupes the miss', async () => {
      const { svc, prisma, cache } = makeService();
      prisma.userContextCard.findFirst.mockResolvedValue(null);
      const a = await svc.dispatch('get_user_context_card', { username: 'alice' }, baseCtx);
      const b = await svc.dispatch('get_user_context_card', { username: 'alice' }, baseCtx);
      expect(JSON.parse(a)).toEqual({ error: 'no_card', note: expect.any(String) });
      expect(JSON.parse(b)).toEqual({ error: 'no_card', note: expect.any(String) });
      // The DB miss happens once; the second call hits the negative cache.
      expect(prisma.userContextCard.findFirst).toHaveBeenCalledTimes(1);
      expect(cache.counters().hits).toBe(1);
    });

    it('get_post_thread_summary: missing summary returns no_summary and dedupes', async () => {
      const { svc, prisma, cache } = makeService();
      prisma.post.findFirst.mockResolvedValue({ id: 'r-1' });
      prisma.marvinThreadSummary.findUnique.mockResolvedValue(null);
      const a = await svc.dispatch('get_post_thread_summary', { rootPostId: 'r-1' }, baseCtx);
      const b = await svc.dispatch('get_post_thread_summary', { rootPostId: 'r-1' }, baseCtx);
      expect(JSON.parse(a)).toEqual({ error: 'no_summary', note: expect.any(String) });
      expect(JSON.parse(b)).toEqual({ error: 'no_summary', note: expect.any(String) });
      expect(prisma.marvinThreadSummary.findUnique).toHaveBeenCalledTimes(1);
      expect(cache.counters().hits).toBe(1);
    });
  });

  describe('get_bible_passage', () => {
    it('returns passage text from ScriptureService', async () => {
      const { svc, scripture } = makeService();
      const raw = await svc.dispatch('get_bible_passage', { reference: 'John 3:16' }, baseCtx);
      const parsed = JSON.parse(raw);
      expect(parsed.reference).toBe('John 3:16');
      expect(parsed.text).toContain('loved the world');
      expect(scripture.getRef).toHaveBeenCalledWith('John 3:16');
    });

    it('returns not_found for unknown references', async () => {
      const { svc } = makeService();
      const raw = await svc.dispatch('get_bible_passage', { reference: 'NotABook 1:1' }, baseCtx);
      expect(JSON.parse(raw).error).toBe('not_found');
    });
  });

  describe('find_similar_members', () => {
    it('ranks members by interest overlap', async () => {
      const { svc, prisma } = makeService();
      prisma.user = {
        findUnique: jest.fn(async () => ({
          interests: ['woodworking', 'fasting'],
          contextCard: { cardText: 'Loves woodworking.' },
        })),
        findMany: jest.fn(async ({ where }: any) => {
          if (where?.interests?.hasSome) {
            return [
              {
                username: 'bob',
                name: 'Bob',
                interests: ['woodworking'],
                contextCard: { cardText: 'Shop projects on weekends.' },
              },
            ];
          }
          return [];
        }),
      };
      const raw = await svc.dispatch('find_similar_members', { query: 'woodworking' }, baseCtx);
      const parsed = JSON.parse(raw);
      expect(parsed.members[0].username).toBe('bob');
      expect(parsed.members[0].reasons[0]).toMatch(/woodworking/);
    });
  });
});
