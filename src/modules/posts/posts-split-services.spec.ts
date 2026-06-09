import { ForbiddenException, NotFoundException } from '@nestjs/common';
import { PostsDraftsService } from './posts-drafts.service';
import { PostsRankingService } from './posts-ranking.service';
import { notDeletedWhere, excludeCommunityGroupPostsWhere, mediaOnlyWhere, userNotBannedWhere } from './posts-query-builders';

describe('posts-query-builders', () => {
  it('builds the shared post where-clauses', () => {
    expect(notDeletedWhere()).toEqual({ deletedAt: null });
    expect(excludeCommunityGroupPostsWhere()).toEqual({ communityGroupId: null });
    expect(mediaOnlyWhere()).toEqual({ media: { some: { deletedAt: null } } });
    expect(userNotBannedWhere()).toEqual({ user: { bannedAt: null } });
  });
});

describe('PostsRankingService', () => {
  it('enqueueScoreRefresh enqueues a deduplicated job keyed by post id', () => {
    const jobs = { enqueue: jest.fn(async () => undefined) };
    const service = new PostsRankingService({} as any, jobs as any);

    service.enqueueScoreRefresh('p1');

    expect(jobs.enqueue).toHaveBeenCalledWith(
      expect.any(String),
      { postId: 'p1' },
      expect.objectContaining({ jobId: 'score-p1' }),
    );
  });

  it('enqueueScoreRefresh is a no-op without a post id', () => {
    const jobs = { enqueue: jest.fn(async () => undefined) };
    const service = new PostsRankingService({} as any, jobs as any);

    service.enqueueScoreRefresh('');

    expect(jobs.enqueue).not.toHaveBeenCalled();
  });

  it('ensureBoostScoresFresh returns an empty map for no ids', async () => {
    const prisma = { post: { findMany: jest.fn() } };
    const service = new PostsRankingService(prisma as any, { enqueue: jest.fn() } as any);

    const out = await service.ensureBoostScoresFresh([]);

    expect(out.size).toBe(0);
    expect(prisma.post.findMany).not.toHaveBeenCalled();
  });
});

describe('PostsDraftsService.deleteDraft', () => {
  function makeService(postRow: unknown) {
    const prisma: any = {
      post: {
        findUnique: jest.fn(async () => postRow),
        update: jest.fn(async () => ({})),
      },
    };
    return { service: new PostsDraftsService(prisma), prisma };
  }

  it('throws NotFound when the draft does not exist', async () => {
    const { service } = makeService(null);
    await expect(service.deleteDraft({ userId: 'u1', draftId: 'd1' })).rejects.toBeInstanceOf(NotFoundException);
  });

  it('throws Forbidden when the draft belongs to another user', async () => {
    const { service } = makeService({ id: 'd1', userId: 'other', deletedAt: null, visibility: 'onlyMe', isDraft: true });
    await expect(service.deleteDraft({ userId: 'u1', draftId: 'd1' })).rejects.toBeInstanceOf(ForbiddenException);
  });

  it('throws Forbidden when the post is not a draft', async () => {
    const { service } = makeService({ id: 'd1', userId: 'u1', deletedAt: null, visibility: 'public', isDraft: false });
    await expect(service.deleteDraft({ userId: 'u1', draftId: 'd1' })).rejects.toBeInstanceOf(ForbiddenException);
  });

  it('soft-deletes the draft', async () => {
    const { service, prisma } = makeService({ id: 'd1', userId: 'u1', deletedAt: null, visibility: 'onlyMe', isDraft: true });
    const res = await service.deleteDraft({ userId: 'u1', draftId: 'd1' });
    expect(res).toEqual({ success: true });
    expect(prisma.post.update).toHaveBeenCalledWith({ where: { id: 'd1' }, data: { deletedAt: expect.any(Date) } });
  });

  it('is idempotent for already-deleted drafts', async () => {
    const { service, prisma } = makeService({ id: 'd1', userId: 'u1', deletedAt: new Date(), visibility: 'onlyMe', isDraft: true });
    const res = await service.deleteDraft({ userId: 'u1', draftId: 'd1' });
    expect(res).toEqual({ success: true });
    expect(prisma.post.update).not.toHaveBeenCalled();
  });
});
