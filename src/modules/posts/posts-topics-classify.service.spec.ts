import { PostsTopicsClassifyService } from './posts-topics-classify.service';

function makeService(opts?: { configured?: boolean; completeText?: string | null }) {
  const post = {
    id: 'p1',
    isDraft: false,
    kind: 'regular',
    body: 'Hit a new squat PR after church.',
    hashtags: [],
    topics: [] as string[],
    topicsClassifiedAt: null as Date | null,
    visibility: 'public',
    communityGroupId: null,
    deletedAt: null,
  };
  const prisma: any = {
    post: {
      findFirst: jest.fn(async () => post),
      findMany: jest.fn(async () => [post]),
      updateMany: jest.fn(async () => ({ count: 1 })),
    },
  };
  const ai: any = {
    isConfigured: jest.fn(() => opts?.configured !== false),
    complete: jest.fn(async () =>
      opts?.completeText === null ? null : { text: opts?.completeText ?? '["faith","strength_training"]', modelUsed: 'gpt-5.6-luna' },
    ),
  };
  const jobs: any = { enqueue: jest.fn(async () => ({ id: 'job' })) };
  const appConfig: any = { marvOpenAI: jest.fn(() => ({ fastModel: 'gpt-5.6-luna' })) };
  const cacheInvalidation: any = { bumpForPostWrite: jest.fn(async () => undefined) };
  const service = new PostsTopicsClassifyService(prisma, ai, jobs, appConfig, cacheInvalidation);
  return { service, prisma, ai, jobs, cacheInvalidation, post };
}

describe('PostsTopicsClassifyService', () => {
  it('skips group, only-me, already-classified, and empty posts', () => {
    const { service } = makeService();
    expect(service.isEligible({ visibility: 'public', communityGroupId: 'g1', topics: [], body: 'hi', hashtags: [] })).toBe(false);
    expect(service.isEligible({ visibility: 'onlyMe', communityGroupId: null, topics: [], body: 'hi', hashtags: [] })).toBe(false);
    expect(service.isEligible({ visibility: 'public', communityGroupId: null, topics: ['faith'], body: 'hi', hashtags: [] })).toBe(true);
    expect(service.isEligible({ visibility: 'public', communityGroupId: null, topics: [], topicsClassifiedAt: new Date(), body: 'long enough for luna classify', hashtags: [] })).toBe(false);
    expect(service.isEligible({ visibility: 'public', communityGroupId: null, topics: [], body: '', hashtags: [] })).toBe(false);
    expect(service.isEligible({ visibility: 'public', communityGroupId: null, topics: [], body: 'hi', hashtags: [] })).toBe(true);
    expect(service.isThinForAi({ body: 'ok', hashtags: [] })).toBe(true);
    expect(service.isThinForAi({ body: 'Hit a new squat PR after church today.', hashtags: [] })).toBe(false);
  });

  it('writes allowlisted topics and bumps search caches', async () => {
    const { service, prisma, cacheInvalidation } = makeService();
    const result = await service.process({ postId: 'p1' });
    expect(result).toEqual({ classified: 1, examined: 1 });
    expect(prisma.post.updateMany).toHaveBeenCalledWith({
      where: expect.objectContaining({ id: 'p1', topicsClassifiedAt: null, deletedAt: null }),
      data: { topics: ['faith', 'strength_training'], topicsClassifiedAt: expect.any(Date) },
    });
    expect(cacheInvalidation.bumpForPostWrite).toHaveBeenCalledWith({ topics: ['faith', 'strength_training'], invalidateFeed: false });
  });

  it('stamps classifiedAt when the model returns nothing usable so we do not re-pay', async () => {
    const { service, prisma } = makeService({ completeText: '[]' });
    const result = await service.process({ postId: 'p1' });
    expect(result.classified).toBe(0);
    expect(prisma.post.updateMany).toHaveBeenCalledWith({
      where: expect.objectContaining({ id: 'p1', topicsClassifiedAt: null, deletedAt: null }),
      data: { topics: [], topicsClassifiedAt: expect.any(Date) },
    });
  });

  it('enqueues a one-shot job for an eligible post', async () => {
    const { service, jobs } = makeService();
    await service.enqueueIfNeeded('p1');
    expect(jobs.enqueue).toHaveBeenCalledWith(
      'posts.topicsAiClassify',
      { postId: 'p1' },
      expect.objectContaining({ jobId: 'topics-ai-p1' }),
    );
  });
});


describe('topic enrichment cost and freshness', () => {
  it('adds gaming to a Warcraft post even when a keyword already tagged fatherhood, once only', async () => {
    const { service, post, prisma, ai } = makeService({ completeText: '["gaming", "fatherhood"]' });
    post.body = "Looking forward to World of Warcraft: Forever at my own slow-dad pace.";
    post.topics = ['fatherhood'];
    await service.enqueueIfNeeded(post.id);
    await service.process({ postId: post.id });
    const data = prisma.post.updateMany.mock.calls[0][0].data;
    expect(data.topics).toEqual(['fatherhood', 'gaming']);
    Object.assign(post, data);
    await service.process({ postId: post.id });
    expect(ai.complete).toHaveBeenCalledTimes(1);
  });

  it('bounds input and output using the existing fast model, without search tools', async () => {
    const { service, post, ai } = makeService();
    post.body = 'x'.repeat(20_000);
    await service.process({ postId: post.id });
    expect(ai.complete).toHaveBeenCalledWith(expect.objectContaining({
      model: 'gpt-5.6-luna', maxOutputTokens: 256, reasoningEffort: 'low',
      userMessage: `Body:\n${'x'.repeat(2_000)}`,
    }));
  });

  it('does not mark a failed API call as successfully classified', async () => {
    const { service, prisma } = makeService({ completeText: null });
    await expect(service.process({ postId: 'p1' })).rejects.toThrow('unavailable');
    expect(prisma.post.updateMany).not.toHaveBeenCalled();
  });

  it('ignores a result when content changed while AI was running', async () => {
    const { service, post, prisma, cacheInvalidation } = makeService();
    prisma.post.updateMany.mockResolvedValue({ count: 0 });
    expect(await service.process({ postId: 'p1' })).toEqual({ classified: 0, examined: 1 });
    expect(prisma.post.updateMany).toHaveBeenCalledWith(expect.objectContaining({
      where: expect.objectContaining({ body: post.body, visibility: 'public', topics: { equals: [] } }),
    }));
    expect(cacheInvalidation.bumpForPostWrite).not.toHaveBeenCalled();
  });

  it('includes keyword-tagged historical posts in bounded backfill', async () => {
    const { service, prisma } = makeService();
    await service.process({ batchSize: 20 });
    const query = prisma.post.findMany.mock.calls[0][0];
    expect(query.where.topicsClassifiedAt).toBeNull();
    expect(query.where).not.toHaveProperty('topics');
    expect(query.take).toBe(20);
  });
});


describe('classification eligibility', () => {
  it.each([{ isDraft: true }, { kind: 'repost' }])('does not spend on unpublished or duplicate posts: %s', async (extra) => {
    const { service, post, ai } = makeService();
    Object.assign(post, extra);
    await service.process({ postId: post.id });
    expect(ai.complete).not.toHaveBeenCalled();
  });
});

describe('PostsTopicsClassifyService.classifyFromImageNote', () => {
  function make(opts: { post?: any; jevTopics?: string[] | null; available?: boolean; count?: number } = {}) {
    const prisma: any = {
      post: {
        findFirst: jest.fn(async () => (opts.post === undefined ? { topics: [] } : opts.post)),
        updateMany: jest.fn(async () => ({ count: opts.count ?? 1 })),
      },
    };
    const ai: any = { isConfigured: jest.fn(() => true), complete: jest.fn() };
    const jev: any = {
      available: jest.fn(() => opts.available !== false),
      topicsFor: jest.fn(async () => (opts.jevTopics === undefined ? ['fitness'] : opts.jevTopics)),
    };
    const cacheInvalidation: any = { bumpForPostWrite: jest.fn(async () => undefined) };
    const service = new PostsTopicsClassifyService(prisma, ai, {} as any, {} as any, cacheInvalidation, jev);
    return { service, prisma, ai, jev, cacheInvalidation };
  }

  it('asks Jev once, never OpenAI, and merges topics onto an unlabeled public post', async () => {
    const { service, prisma, ai, jev, cacheInvalidation } = make();
    await expect(service.classifyFromImageNote('p1', 'A barbell on a rack in a garage gym')).resolves.toBe(true);
    expect(jev.topicsFor).toHaveBeenCalledWith('A barbell on a rack in a garage gym', 'public post');
    expect(ai.complete).not.toHaveBeenCalled();
    expect(prisma.post.findFirst.mock.calls[0][0].where).toMatchObject({ visibility: 'public', communityGroupId: null });
    expect(prisma.post.updateMany.mock.calls[0][0]).toMatchObject({ where: { topics: { isEmpty: true } }, data: { topics: ['fitness'] } });
    expect(cacheInvalidation.bumpForPostWrite).toHaveBeenCalledWith({ topics: ['fitness'], invalidateFeed: false });
  });

  it('leaves labeled, non-public, or ungrouped-ineligible posts and unavailable Jev alone', async () => {
    const labeled = make({ post: { topics: ['faith'] } });
    await expect(labeled.service.classifyFromImageNote('p1', 'A bench')).resolves.toBe(false);
    expect(labeled.jev.topicsFor).not.toHaveBeenCalled();
    const missing = make({ post: null });
    await expect(missing.service.classifyFromImageNote('p1', 'A bench')).resolves.toBe(false);
    expect(missing.jev.topicsFor).not.toHaveBeenCalled();
    const off = make({ available: false });
    await expect(off.service.classifyFromImageNote('p1', 'A bench')).resolves.toBe(false);
    expect(off.jev.topicsFor).not.toHaveBeenCalled();
  });

  it('writes nothing when Jev has no answer or a concurrent edit already set topics', async () => {
    const none = make({ jevTopics: null });
    await expect(none.service.classifyFromImageNote('p1', 'A bench')).resolves.toBe(false);
    expect(none.prisma.post.updateMany).not.toHaveBeenCalled();
    const empty = make({ jevTopics: [] });
    await expect(empty.service.classifyFromImageNote('p1', 'A bench')).resolves.toBe(false);
    const raced = make({ count: 0 });
    await expect(raced.service.classifyFromImageNote('p1', 'A bench')).resolves.toBe(false);
    expect(raced.cacheInvalidation.bumpForPostWrite).not.toHaveBeenCalled();
  });
});

describe('PostsTopicsClassifyService (Jev first)', () => {
  function withJev(topics: string[] | null) {
    const base = makeService();
    const jev: any = { available: () => true, topicsFor: jest.fn(async () => topics) };
    const service = new PostsTopicsClassifyService(base.prisma, base.ai, base.jobs, { marvOpenAI: () => ({ fastModel: 'm' }) } as any, base.cacheInvalidation, jev);
    return { ...base, service, jev };
  }

  it('uses Jev topics without calling OpenAI', async () => {
    const { service, ai, prisma } = withJev(['faith']);
    await service.process({ postId: 'p1' });
    expect(ai.complete).not.toHaveBeenCalled();
    expect(prisma.post.updateMany).toHaveBeenCalledWith(expect.objectContaining({ data: { topics: ['faith'], topicsClassifiedAt: expect.any(Date) } }));
  });

  it('falls back to OpenAI only when Jev is unavailable', async () => {
    const { service, ai, prisma } = withJev(null);
    await service.process({ postId: 'p1' });
    expect(ai.complete).toHaveBeenCalledTimes(1);
    expect(prisma.post.updateMany).toHaveBeenCalledWith(expect.objectContaining({ data: { topics: ['faith', 'strength_training'], topicsClassifiedAt: expect.any(Date) } }));
  });
});
