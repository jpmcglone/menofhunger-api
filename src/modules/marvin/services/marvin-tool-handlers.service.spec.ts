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

  const getJson = jest.fn(async (key: string) => {
    if (!store.has(key)) return null;
    return store.get(key);
  });

  const setJson = jest.fn(async (key: string, value: unknown) => {
    store.set(key, value);
  });

  const cache: any = { getOrSetJson, getOrSetNullableJson, getJson, setJson };

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
    user: { findFirst: jest.fn(), findMany: jest.fn(async () => []) },
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
    ensureLiveCard: jest.fn(async (username: string) => {
      if (username.toLowerCase() === 'eve') return null;
      return {
        userId: 'u-1',
        username: username.toLowerCase() === 'alice' ? 'alice' : username,
        cardText: 'Alice is a member on the platform.',
        source: 'fallback',
        updatedAt: new Date('2026-01-01T00:00:00Z'),
      };
    }),
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
  const appConfig: any = { r2: jest.fn(() => ({ publicBaseUrl: 'https://cdn.test' })) };
  const svc = new MarvinToolHandlersService(
    prisma,
    identity,
    fake.cache,
    contextCard,
    scripture,
    jobs,
    appConfig,
  );
  return { svc, prisma, identity, cache: fake, contextCard, scripture, jobs, appConfig };
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
    it('returns user_not_found when the member cannot be resolved', async () => {
      const { svc, jobs } = makeService();
      const out = await svc.dispatch('get_user_context_card', { username: 'eve' }, baseCtx);
      expect(JSON.parse(out)).toEqual({ error: 'user_not_found', note: expect.any(String) });
      expect(jobs.enqueue).not.toHaveBeenCalled();
    });

    it('enqueues a card refresh and returns a live fallback without blocking on AI', async () => {
      const { svc, jobs, contextCard } = makeService();
      const out = await svc.dispatch('get_user_context_card', { username: 'alice' }, baseCtx);
      const parsed = JSON.parse(out);
      expect(parsed.source).toBe('fallback');
      expect(parsed.cardText).toMatch(/alice/i);
      expect(contextCard.refreshCardForUser).not.toHaveBeenCalled();
      expect(contextCard.ensureLiveCard).toHaveBeenCalledWith('alice');
      expect(jobs.enqueue).toHaveBeenCalledWith(
        'marvin.contextCard.refresh',
        { userId: 'u-1' },
        expect.objectContaining({ jobId: 'marvin-context-card-u-1', delay: 30_000 }),
      );
    });

    it('returns a persisted generated card without enqueueing', async () => {
      const { svc, contextCard, jobs } = makeService();
      contextCard.ensureLiveCard.mockResolvedValueOnce({
        userId: 'u-1',
        username: 'alice',
        cardText: 'Alice is a long-time member.',
        source: 'generated',
        updatedAt: new Date('2026-01-01T00:00:00Z'),
      });
      const out = await svc.dispatch('get_user_context_card', { username: 'alice' }, baseCtx);
      const parsed = JSON.parse(out);
      expect(parsed.cardText).toContain('Alice');
      expect(parsed.source).toBe('generated');
      expect(jobs.enqueue).not.toHaveBeenCalled();
    });

    it('lookupMemberCards prefetches found and missing members', async () => {
      const { svc } = makeService();
      const cards = await svc.lookupMemberCards(['alice', 'eve', 'alice']);
      expect(cards).toEqual([
        { username: 'alice', cardText: 'Alice is a member on the platform.' },
        { username: 'eve', cardText: null },
      ]);
    });

    it('collectMentionedMemberCards reads @mentions first, then extra authors, and skips Marv', async () => {
      const { svc } = makeService();
      const cards = await svc.collectMentionedMemberCards({
        bodies: ['hey @alice and @marv', 'also @eve'],
        extraUsernames: ['bob', 'marv'],
      });
      expect(cards.map((c) => c.username)).toEqual(['alice', 'eve', 'bob']);
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
    it('get_user_context_card: unknown member returns user_not_found and dedupes the miss', async () => {
      const { svc, contextCard, cache } = makeService();
      const a = await svc.dispatch('get_user_context_card', { username: 'eve' }, baseCtx);
      const b = await svc.dispatch('get_user_context_card', { username: 'eve' }, baseCtx);
      expect(JSON.parse(a)).toEqual({ error: 'user_not_found', note: expect.any(String) });
      expect(JSON.parse(b)).toEqual({ error: 'user_not_found', note: expect.any(String) });
      expect(contextCard.ensureLiveCard).toHaveBeenCalledTimes(1);
      expect(cache.get('marv:tool:user-card:eve')).toEqual({ meta: null });
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

  describe('find_members_by_name', () => {
    it('maps a first or last name to @username', async () => {
      const { svc, prisma } = makeService();
      prisma.user.findMany.mockResolvedValueOnce([
        { username: 'jpmcglone', name: 'John McGlone' },
      ]);
      const raw = await svc.dispatch('find_members_by_name', { name: 'McGlone' }, baseCtx);
      const parsed = JSON.parse(raw);
      expect(parsed.members).toEqual([{ username: 'jpmcglone', displayName: 'John McGlone' }]);
      expect(parsed.note).toMatch(/@username/);
    });

    it('ranks an in-thread match first when several people share the name', async () => {
      const { svc, prisma } = makeService();
      prisma.user.findMany.mockResolvedValueOnce([
        { username: 'timw', name: 'Tim Wells' },
        { username: 'timk', name: 'Tim Kane' },
      ]);
      prisma.post.findMany.mockResolvedValueOnce([
        { user: { username: 'timk' } },
        { user: { username: 'alice' } },
      ]);
      const raw = await svc.dispatch('find_members_by_name', { name: 'Tim' }, baseCtx);
      const parsed = JSON.parse(raw);
      expect(parsed.members[0]).toEqual({ username: 'timk', displayName: 'Tim Kane' });
      expect(parsed.note).toMatch(/@timk is in this conversation/);
    });

    it('says when no conversation participant matched', async () => {
      const { svc, prisma } = makeService();
      prisma.user.findMany.mockResolvedValueOnce([
        { username: 'timw', name: 'Tim Wells' },
        { username: 'timk', name: 'Tim Kane' },
      ]);
      const raw = await svc.dispatch('find_members_by_name', { name: 'Tim' }, baseCtx);
      const parsed = JSON.parse(raw);
      expect(parsed.members).toHaveLength(2);
      expect(parsed.note).toMatch(/Nobody in this conversation matched/);
    });

    it('rejects a one-character name', async () => {
      const { svc } = makeService();
      const raw = await svc.dispatch('find_members_by_name', { name: 'J' }, baseCtx);
      expect(JSON.parse(raw)).toEqual({ error: 'invalid_args' });
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

  describe('list_public_posts', () => {
    const publicRow = {
      id: 'p-pub',
      body: 'Morning lift.',
      createdAt: new Date('2026-09-04T12:00:00Z'),
      visibility: 'public',
      rootId: 'p-pub',
      parentId: null,
      checkinPrompt: 'What are you grateful for?',
      user: { username: 'alice', name: 'Alice', isBot: false },
      media: [
        { kind: 'image', source: 'upload', r2Key: 'images/lift.jpg', url: null, thumbnailR2Key: null },
      ],
      poll: {
        totalVoteCount: 3,
        options: [{ text: 'Yes', voteCount: 3 }],
      },
    };

    it('returns recent public lodge posts with text, media, poll, and check-in', async () => {
      const { svc, prisma } = makeService();
      prisma.post.findMany.mockResolvedValueOnce([publicRow]);
      const raw = await svc.dispatch('list_public_posts', {}, baseCtx);
      const parsed = JSON.parse(raw);
      expect(parsed.posts).toHaveLength(1);
      expect(parsed.posts[0]).toMatchObject({
        id: 'p-pub',
        body: 'Morning lift.',
        checkinPrompt: 'What are you grateful for?',
        media: ['image'],
        imageUrls: ['https://cdn.test/images/lift.jpg'],
        author: { username: 'alice', displayName: 'Alice' },
      });
      expect(parsed.posts[0].poll.options[0].text).toBe('Yes');
      const where = prisma.post.findMany.mock.calls[0][0].where;
      expect(where.visibility).toBe('public');
      expect(where.parentId).toBeNull();
      expect(where.communityGroupId).toBeNull();
    });

    it('treats empty username and "all" as the general lodge feed', async () => {
      const { svc, prisma } = makeService();
      prisma.post.findMany.mockResolvedValue([publicRow]);
      for (const args of [{ username: '' }, { username: 'all' }, { username: '@feed' }, { username: 'omit' }]) {
        const parsed = JSON.parse(await svc.dispatch('list_public_posts', args, baseCtx));
        expect(parsed.error).toBeUndefined();
        expect(parsed.posts).toHaveLength(1);
        expect(prisma.post.findMany.mock.calls.at(-1)?.[0].where.user.username).toBeUndefined();
      }
    });

    it('filters to one member and 404s an unknown handle', async () => {
      const { svc, prisma } = makeService();
      prisma.user.findFirst.mockResolvedValueOnce({ id: 'u-alice' });
      prisma.post.findMany.mockResolvedValueOnce([publicRow]);
      const ok = JSON.parse(await svc.dispatch('list_public_posts', { username: 'alice' }, baseCtx));
      expect(ok.posts[0].author.username).toBe('alice');
      expect(prisma.post.findMany.mock.calls[0][0].where.user.username).toEqual({
        equals: 'alice',
        mode: 'insensitive',
      });

      prisma.user.findFirst.mockResolvedValueOnce(null);
      const missing = JSON.parse(await svc.dispatch('list_public_posts', { username: 'nobody' }, baseCtx));
      expect(missing.error).toBe('user_not_found');
      expect(missing.posts).toEqual([]);
    });
  });
});
