import { ForbiddenException } from '@nestjs/common';
import { PollsService } from './polls.service';

const mockPoll = {
  id: 'poll-1',
  postId: 'post-1',
  endsAt: new Date(Date.now() + 86_400_000),
  totalVoteCount: 0,
  creatorSkippedAt: null,
  options: [
    { id: 'opt-1', position: 0, voteCount: 0, imageR2Key: null },
    { id: 'opt-2', position: 1, voteCount: 0, imageR2Key: null },
  ],
};

const mockPost = { id: 'post-1', userId: 'user-1', deletedAt: null, visibility: 'public' as const };
const mockViewer = { id: 'user-2', verifiedStatus: 'manual' as const, premium: false, premiumPlus: false, siteAdmin: false };

function makePollsService() {
  const emitPostsLiveUpdated = jest.fn();
  const realtime: any = { emitPostsLiveUpdated };

  const prisma: any = {
    post: {
      findFirst: jest.fn(async () => mockPost),
    },
    postPoll: {
      findUnique: jest.fn(async () => mockPoll),
      update: jest.fn(async ({ data }: any) => ({
        ...mockPoll,
        totalVoteCount: data.totalVoteCount?.increment
          ? mockPoll.totalVoteCount + data.totalVoteCount.increment
          : mockPoll.totalVoteCount,
      })),
    },
    postPollOption: {
      update: jest.fn(async () => ({})),
    },
    postPollVote: {
      create: jest.fn(async () => ({})),
      findUnique: jest.fn(async () => null),
    },
    $transaction: jest.fn(async (fn: any) => {
      const tx: any = {
        postPoll: {
          findUnique: jest.fn(async () => mockPoll),
          update: jest.fn(async ({ data }: any) => ({
            ...mockPoll,
            totalVoteCount: mockPoll.totalVoteCount + (data.totalVoteCount?.increment ?? 0),
          })),
        },
        postPollOption: { update: jest.fn(async () => ({})) },
        postPollVote: {
          create: jest.fn(async () => ({})),
          findUnique: jest.fn(async () => null),
        },
      };
      return fn(tx);
    }),
  };

  const viewerContext: any = {
    getViewer: jest.fn(async () => mockViewer),
    allowedPostVisibilities: jest.fn(() => ['public', 'verifiedOnly', 'premiumOnly', 'onlyMe']),
  };

  const svc = new PollsService(prisma, viewerContext, realtime);
  return { svc, emitPostsLiveUpdated, prisma };
}

describe('PollsService', () => {
  describe('voteOnPoll', () => {
    it('emits posts:live-updated with poll patch after a successful vote', async () => {
      const { svc, emitPostsLiveUpdated } = makePollsService();

      await svc.voteOnPoll({ userId: 'user-2', postId: 'post-1', optionId: 'opt-1' });

      expect(emitPostsLiveUpdated).toHaveBeenCalledTimes(1);
      const [postId, payload] = emitPostsLiveUpdated.mock.calls[0];
      expect(postId).toBe('post-1');
      expect(payload.reason).toBe('poll_vote');
      expect(payload.patch?.poll).toBeDefined();
    });

    it('throws ForbiddenException if user has already voted (P2002)', async () => {
      const { svc, prisma } = makePollsService();
      // Make the transaction's postPollVote.create throw a P2002 unique-constraint error
      const { Prisma } = jest.requireActual('@prisma/client');
      prisma.$transaction.mockImplementationOnce(async (fn: any) => {
        const tx: any = {
          postPoll: { findUnique: jest.fn(async () => mockPoll) },
          postPollOption: { update: jest.fn() },
          postPollVote: {
            create: jest.fn().mockRejectedValueOnce(
              Object.assign(new Prisma.PrismaClientKnownRequestError('Unique constraint failed', { code: 'P2002', clientVersion: '5' })),
            ),
          },
        };
        return fn(tx);
      });

      await expect(svc.voteOnPoll({ userId: 'user-2', postId: 'post-1', optionId: 'opt-1' })).rejects.toBeInstanceOf(
        ForbiddenException,
      );
    });
  });

  describe('blockUser emit', () => {
    it('emitPostsLiveUpdated is NOT called for skipPoll (creator-only state)', async () => {
      const { svc, emitPostsLiveUpdated } = makePollsService();
      // Override viewer to be the creator
      const postWithCreator = { ...mockPost, userId: 'user-2' };
      (svc as any).prisma = {
        ...(svc as any).prisma,
        post: { findFirst: jest.fn(async () => postWithCreator) },
      };
      await svc.skipPoll({ userId: 'user-2', postId: 'post-1' });
      expect(emitPostsLiveUpdated).not.toHaveBeenCalled();
    });
  });
});
