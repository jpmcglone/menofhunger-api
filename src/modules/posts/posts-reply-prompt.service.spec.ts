import { PostsReplyPromptService } from './posts-reply-prompt.service';

function fixture(body: string | null, answer: { choice: string; probabilities: Record<string, number> } | null) {
  const post = body === null ? null : { id: 'p1', body, createdAt: new Date() };
  const prisma = { post: { findFirst: jest.fn(async () => post), updateMany: jest.fn(async () => ({ count: 1 })) } };
  const decide = jest.fn(async () => (answer ? { answers: { invite: answer } } : null));
  const realtime = { emitPostsLiveUpdated: jest.fn() };
  const service = new PostsReplyPromptService(prisma as never, { isConfigured: () => true, decide } as never, { register: jest.fn() } as never, realtime as never);
  return { service, prisma, decide, realtime };
}

describe('PostsReplyPromptService', () => {
  it('stores a confident question and patches live viewers', async () => {
    const f = fixture('Anyone have advice on cold plunges for beginners?', { choice: 'question', probabilities: { question: 0.85, neither: 0.1 } });
    await f.service.classify({ postId: 'p1' });
    expect(f.prisma.post.updateMany).toHaveBeenCalledWith(expect.objectContaining({ data: { replyPrompt: 'question', replyPromptClassifiedAt: expect.any(Date) } }));
    expect(f.realtime.emitPostsLiveUpdated).toHaveBeenCalledWith('p1', expect.objectContaining({ patch: { replyPrompt: 'question' } }));
  });

  it('marks an announcement or a borderline post as read without a nudge', async () => {
    const answers: Array<{ choice: string; probabilities: Record<string, number> }> = [
      { choice: 'neither', probabilities: { neither: 0.9 } },
      { choice: 'discussion', probabilities: { discussion: 0.45, neither: 0.4 } },
    ];
    for (const answer of answers) {
      const f = fixture('Just finished my morning run and feeling great.', answer);
      await f.service.classify({ postId: 'p1' });
      expect(f.prisma.post.updateMany).toHaveBeenCalledWith(expect.objectContaining({ data: { replyPrompt: null, replyPromptClassifiedAt: expect.any(Date) } }));
      expect(f.realtime.emitPostsLiveUpdated).not.toHaveBeenCalled();
    }
  });

  it('skips Jev for very short posts, ineligible posts, and retries when Jev is down', async () => {
    const short = fixture('Amen', null);
    await short.service.classify({ postId: 'p1' });
    expect(short.decide).not.toHaveBeenCalled();
    const gone = fixture(null, null);
    await gone.service.classify({ postId: 'p1' });
    expect(gone.prisma.post.updateMany).not.toHaveBeenCalled();
    await expect(fixture('A long enough post about something', null).service.classify({ postId: 'p1' })).rejects.toThrow();
  });
});
