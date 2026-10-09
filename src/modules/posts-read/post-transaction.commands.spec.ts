import { Prisma } from '@prisma/client';
import { adjustPostBookmarkCount, eraseAccountPostContent, incrementPostViewCountsBatch } from './post-transaction.commands';

describe('post transaction command ownership', () => {
  it('changes only derived counters in the supplied transaction, preserving decrement semantics', async () => {
    const tx = { post: { updateMany: jest.fn(async () => ({ count: 1 })), update: jest.fn(async () => ({})) } };
    await incrementPostViewCountsBatch(tx as never, ['post'], { unique: 1, weighted: 0.5, total: 1, body: 'injected' } as { unique: number; weighted: number; total: number });
    expect(tx.post.updateMany).toHaveBeenCalledWith({ where: { id: { in: ['post'] } }, data: { viewerCount: { increment: 1 }, weightedViewCount: { increment: 0.5 }, totalViewCount: { increment: 1 } } });
    await adjustPostBookmarkCount(tx as never, 'post', -2);
    expect(tx.post.update).toHaveBeenCalledWith({ where: { id: 'post' }, data: { bookmarkCount: { decrement: 2 } } });
  });

  it('erases only the departing author content while retaining post IDs/thread shells and cleaning derivatives', async () => {
    const tx = {
      post: { findMany: jest.fn(async () => [{ id: 'reply', rootId: 'other-root' }]), updateMany: jest.fn(async () => ({ count: 1 })), deleteMany: jest.fn() },
      postMedia: { deleteMany: jest.fn() }, postPoll: { deleteMany: jest.fn() }, postMention: { deleteMany: jest.fn() }, postLink: { deleteMany: jest.fn() }, marvinThreadSummary: { deleteMany: jest.fn() },
    };
    const now = new Date();
    await expect(eraseAccountPostContent(tx as never, 'departing', 'anonymous', now)).resolves.toEqual(['reply']);
    expect(tx.post.findMany).toHaveBeenCalledWith({ where: { userId: 'departing' }, select: { id: true, rootId: true } });
    expect(tx.post.updateMany).toHaveBeenCalledWith({ where: { userId: 'departing' }, data: { userId: 'anonymous', body: '', deletedAt: now, topics: [], hashtags: [], hashtagCasings: [], cashtags: [], checkinPrompt: null, checkinDayKey: null, scheduledPollJson: Prisma.DbNull, scheduledError: null, scheduledAt: null, fitnessShareId: null } });
    expect(tx.post.deleteMany).not.toHaveBeenCalled();
    expect(tx.postMedia.deleteMany).toHaveBeenCalledWith({ where: { postId: { in: ['reply'] } } });
    expect(tx.marvinThreadSummary.deleteMany).toHaveBeenCalledWith({ where: { rootPostId: { in: ['reply', 'other-root'] } } });
  });
});
