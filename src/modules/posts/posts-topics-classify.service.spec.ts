import { PostsTopicsClassifyService } from './posts-topics-classify.service';

function makeService(opts?: { configured?: boolean; completeText?: string | null }) {
  const post = {
    id: 'p1',
    body: 'Hit a new squat PR after church.',
    hashtags: [],
    topics: [],
    topicsClassifiedAt: null,
    visibility: 'public',
    communityGroupId: null,
    deletedAt: null,
  };
  const prisma: any = {
    post: {
      findFirst: jest.fn(async () => post),
      findMany: jest.fn(async () => [post]),
      update: jest.fn(async () => post),
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
  return { service, prisma, ai, jobs, cacheInvalidation };
}

describe('PostsTopicsClassifyService', () => {
  it('skips group, only-me, already-tagged, and empty posts', () => {
    const { service } = makeService();
    expect(service.isEligible({ visibility: 'public', communityGroupId: 'g1', topics: [], body: 'hi', hashtags: [] })).toBe(false);
    expect(service.isEligible({ visibility: 'onlyMe', communityGroupId: null, topics: [], body: 'hi', hashtags: [] })).toBe(false);
    expect(service.isEligible({ visibility: 'public', communityGroupId: null, topics: ['faith'], body: 'hi', hashtags: [] })).toBe(false);
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
    expect(prisma.post.update).toHaveBeenCalledWith({
      where: { id: 'p1' },
      data: { topics: ['faith', 'strength_training'], topicsClassifiedAt: expect.any(Date) },
    });
    expect(cacheInvalidation.bumpForPostWrite).toHaveBeenCalledWith({ topics: ['faith', 'strength_training'], invalidateFeed: false });
  });

  it('stamps classifiedAt when the model returns nothing usable so we do not re-pay', async () => {
    const { service, prisma } = makeService({ completeText: '[]' });
    const result = await service.process({ postId: 'p1' });
    expect(result.classified).toBe(0);
    expect(prisma.post.update).toHaveBeenCalledWith({
      where: { id: 'p1' },
      data: { topicsClassifiedAt: expect.any(Date) },
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
