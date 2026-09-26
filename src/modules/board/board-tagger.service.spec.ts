import { BoardTaggerService, parseTagList } from './board-tagger.service';

function setup(reply: string | null, thread: Record<string, unknown> | null) {
  const prisma = {
    post: { findFirst: jest.fn().mockResolvedValue(thread) },
    boardTag: {
      findMany: jest.fn().mockResolvedValue([{ slug: 'fitness' }, { slug: 'ask' }]),
      upsert: jest.fn().mockResolvedValue({}),
      updateMany: jest.fn().mockResolvedValue({ count: 1 }),
    },
    boardThread: { update: jest.fn().mockResolvedValue({}) },
  };
  const ai = { complete: jest.fn().mockResolvedValue(reply === null ? null : { text: reply, modelUsed: 'fast' }) };
  const linkMetadata = {
    extractLinks: jest.fn((text: string) => (text.match(/https?:\/\/\S+/g) ?? [])),
    getMetadata: jest.fn().mockResolvedValue({ title: 'Barbell basics', description: 'How to squat', siteName: 'Stronger' }),
  };
  const realtime = { emitPostsLiveUpdated: jest.fn() };
  const service = new BoardTaggerService(
    prisma as any,
    { marvOpenAI: () => ({ fastModel: 'fast' }) } as any,
    ai as any,
    linkMetadata as any,
    realtime as any,
  );
  return { service, prisma, ai, linkMetadata, realtime };
}

const thread = {
  id: 't1',
  body: 'Also this: https://example.com/deadlift',
  boardThread: { title: 'How do you program squats?', url: 'https://stronger.com/squat', tags: ['misc'] },
  article: null,
};

describe('parseTagList', () => {
  it('reads the first JSON array of strings in a reply', () => {
    expect(parseTagList('Sure: ["ask", "fitness"]')).toEqual(['ask', 'fitness']);
    expect(parseTagList('no tags')).toEqual([]);
    expect(parseTagList('[1, "ok"]')).toEqual(['ok']);
  });
});

describe('BoardTaggerService', () => {
  it('tags from the title, text, and every link’s metadata, then updates counts and tells viewers', async () => {
    const { service, prisma, ai, linkMetadata, realtime } = setup('["Ask", "fitness", "strength training", "extra"]', thread);

    await expect(service.tagThread('t1')).resolves.toEqual(['ask', 'fitness', 'strength-training']);

    expect(linkMetadata.getMetadata).toHaveBeenCalledWith('https://stronger.com/squat');
    expect(linkMetadata.getMetadata).toHaveBeenCalledWith('https://example.com/deadlift');
    const message = ai.complete.mock.calls[0][0].userMessage as string;
    expect(message).toContain('Title: How do you program squats?');
    expect(message).toContain('Barbell basics — How to squat');
    expect(message).toContain('Existing vocabulary: fitness, ask');
    expect(prisma.boardThread.update).toHaveBeenCalledWith({ where: { postId: 't1' }, data: { tags: ['ask', 'fitness', 'strength-training'] } });
    expect(prisma.boardTag.upsert).toHaveBeenCalledTimes(3);
    expect(prisma.boardTag.updateMany).toHaveBeenCalledWith(expect.objectContaining({ where: expect.objectContaining({ slug: 'misc' }) }));
    expect(realtime.emitPostsLiveUpdated).toHaveBeenCalledWith('t1', expect.objectContaining({ reason: 'post_edited' }));
  });

  it('leaves tags alone when the model returns nothing usable', async () => {
    const { service, prisma } = setup('I cannot help with that', thread);
    await expect(service.tagThread('t1')).resolves.toBeNull();
    expect(prisma.boardThread.update).not.toHaveBeenCalled();
  });

  it('skips posts that are gone', async () => {
    const { service, ai } = setup('["ask"]', null);
    await expect(service.tagThread('t1')).resolves.toBeNull();
    expect(ai.complete).not.toHaveBeenCalled();
  });
});
