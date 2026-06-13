import { BadRequestException, ForbiddenException, NotFoundException } from '@nestjs/common';
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

describe('PostsDraftsService.createDraft — media/character-limit gates', () => {
  const verifiedUser = { verifiedStatus: 'identity', premium: false, premiumPlus: false };
  const unverifiedUser = { verifiedStatus: 'none', premium: false, premiumPlus: false };
  const premiumUser = { verifiedStatus: 'identity', premium: true, premiumPlus: false };

  const stubPost = (user: typeof verifiedUser) => ({
    id: 'draft-1',
    body: '',
    visibility: 'onlyMe',
    isDraft: true,
    userId: 'u1',
    media: [],
    mentions: [],
    user,
    createdAt: new Date(),
    updatedAt: new Date(),
    topics: [],
    hashtags: [],
    hashtagCasings: [],
  });

  function makeService(user: typeof verifiedUser) {
    const prisma: any = {
      post: {
        findUnique: jest.fn(async () => null),
        create: jest.fn(async () => stubPost(user)),
      },
      user: { findUnique: jest.fn(async () => ({ ...user, id: 'u1' })) },
      // cleanMediaItems calls this to detect reused content-hash keys.
      mediaContentHash: { findMany: jest.fn(async () => []) },
    };
    return { service: new PostsDraftsService(prisma) };
  }

  const image = { source: 'upload' as const, kind: 'image' as const, r2Key: 'uploads/u1/images/x.jpg' };
  const gif = { source: 'giphy' as const, kind: 'gif' as const, url: 'https://media.giphy.com/x.gif' };
  const video = { source: 'upload' as const, kind: 'video' as const, r2Key: 'uploads/u1/videos/x.mp4' };

  it('allows verified user to create a draft with an image', async () => {
    const { service } = makeService(verifiedUser);
    await expect(service.createDraft({ userId: 'u1', body: 'hello', media: [image] })).resolves.toBeDefined();
  });

  it('allows verified user to create a draft with a GIF', async () => {
    const { service } = makeService(verifiedUser);
    await expect(service.createDraft({ userId: 'u1', body: 'hello', media: [gif] })).resolves.toBeDefined();
  });

  it('blocks unverified user from creating a draft with an image', async () => {
    const { service } = makeService(unverifiedUser);
    await expect(service.createDraft({ userId: 'u1', body: 'hello', media: [image] })).rejects.toThrow(
      new ForbiddenException('Verify your account to post images and GIFs.'),
    );
  });

  it('blocks verified (non-premium) user from creating a draft with video', async () => {
    const { service } = makeService(verifiedUser);
    await expect(service.createDraft({ userId: 'u1', body: 'hello', media: [video] })).rejects.toThrow(
      new ForbiddenException('Video posts are for premium members only.'),
    );
  });

  it('allows premium user to create a draft with video', async () => {
    const { service } = makeService(premiumUser);
    await expect(service.createDraft({ userId: 'u1', body: 'hello', media: [video] })).resolves.toBeDefined();
  });

  it('enforces 500-char body limit for verified (non-premium) users', async () => {
    const { service } = makeService(verifiedUser);
    await expect(service.createDraft({ userId: 'u1', body: 'x'.repeat(501), media: null })).rejects.toThrow(
      BadRequestException,
    );
  });

  it('allows 500-char body for verified (non-premium) users', async () => {
    const { service } = makeService(verifiedUser);
    await expect(service.createDraft({ userId: 'u1', body: 'x'.repeat(500), media: null })).resolves.toBeDefined();
  });

  it('enforces 500-char body limit for unverified users', async () => {
    const { service } = makeService(unverifiedUser);
    await expect(service.createDraft({ userId: 'u1', body: 'x'.repeat(501), media: null })).rejects.toThrow(
      BadRequestException,
    );
  });

  it('allows 500-char body for unverified users', async () => {
    const { service } = makeService(unverifiedUser);
    await expect(service.createDraft({ userId: 'u1', body: 'x'.repeat(500), media: null })).resolves.toBeDefined();
  });

  it('allows 2000-char body for premium users', async () => {
    const { service } = makeService(premiumUser);
    await expect(service.createDraft({ userId: 'u1', body: 'x'.repeat(2000), media: null })).resolves.toBeDefined();
  });

  it('blocks premium user from 2001-char body', async () => {
    const { service } = makeService(premiumUser);
    await expect(service.createDraft({ userId: 'u1', body: 'x'.repeat(2001), media: null })).rejects.toThrow(
      BadRequestException,
    );
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
