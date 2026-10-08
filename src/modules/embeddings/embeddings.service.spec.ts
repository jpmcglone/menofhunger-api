import { EmbeddingsService, groupText, hashText, parseVector, postText, userText, vectorLiteral } from './embeddings.service';

import { PostsReadService } from '../posts-read/posts-read.service';
const create = jest.fn();
jest.mock('openai', () => ({
  __esModule: true,
  default: jest.fn().mockImplementation(() => ({ embeddings: { create } })),
}));

function make(cfg: Partial<{ enabled: boolean; dailyBudgetUsd: number }> = {}, prisma: any = {}) {
  const config: any = {
    embeddings: () => ({
      enabled: true, apiKey: 'k', model: 'm', dimensions: 4, dailyBudgetUsd: 1, usdPerMillionTokens: 0.02, ...cfg,
    }),
  };
  return new EmbeddingsService(config, prisma, new PostsReadService(prisma as never));
}

const reply = (n: number, tokens = 10) => ({
  usage: { total_tokens: tokens },
  data: Array.from({ length: n }, (_, index) => ({ index, embedding: [index, 0, 0, 1] })),
});

describe('EmbeddingsService', () => {
  beforeEach(() => create.mockReset());

  it('returns null without calling OpenAI when disabled', async () => {
    expect(await make({ enabled: false }).embedQuery('hello there')).toBeNull();
    expect(create).not.toHaveBeenCalled();
  });

  it('caches a repeated query so it is embedded once', async () => {
    create.mockResolvedValue(reply(1));
    const svc = make();
    expect(await svc.embedQuery('Stop Doomscrolling')).toEqual([0, 0, 0, 1]);
    expect(await svc.embedQuery('stop doomscrolling')).toEqual([0, 0, 0, 1]);
    expect(create).toHaveBeenCalledTimes(1);
  });

  it('stops calling OpenAI once the daily dollar budget is spent', async () => {
    create.mockResolvedValue(reply(1, 1_000_000));
    const svc = make({ dailyBudgetUsd: 0.01 });
    expect(await svc.embedMany(['one'])).not.toBeNull();
    expect(svc.available()).toBe(false);
    expect(await svc.embedMany(['two'])).toBeNull();
    expect(create).toHaveBeenCalledTimes(1);
    expect(svc.health().budgetExhausted).toBe(true);
  });

  it('is fail-soft when the API errors', async () => {
    create.mockRejectedValue(new Error('429'));
    expect(await make().embedMany(['x'])).toBeNull();
  });

  it('skips re-embedding a post whose text has not changed', async () => {
    const text = postText('A long enough post about lifting weights.', ['gym']);
    const prisma: any = {
      post: { findFirst: jest.fn(async () => ({ id: 'p1', body: 'A long enough post about lifting weights.', hashtags: ['gym'] })) },
      $queryRaw: jest.fn(async () => [{ id: 'p1', h: hashText(text) }]),
      $executeRaw: jest.fn(async () => 1),
    };
    await make({}, prisma).indexPost('p1');
    expect(create).not.toHaveBeenCalled();
    expect(prisma.$executeRaw).not.toHaveBeenCalled();
  });

  it('embeds a photo post with no caption from its Marv note', async () => {
    create.mockResolvedValue(reply(1));
    const prisma: any = {
      post: { findFirst: jest.fn(async () => ({ id: 'p1', body: '', hashtags: [], media: [{ r2Key: 'posts/a.jpg', thumbnailR2Key: null }] })) },
      mediaSearchNote: { findMany: jest.fn(async () => [{ note: 'A red barbell on a rack' }]) },
      $queryRaw: jest.fn(async () => []),
      $executeRaw: jest.fn(async () => 1),
    };
    await make({}, prisma).indexPost('p1');
    expect(create.mock.calls.at(-1)?.[0].input).toEqual([postText('', [], ['A red barbell on a rack'])]);
    expect(prisma.$executeRaw).toHaveBeenCalled();
  });

  it('does not index a thin photo post that has no note', async () => {
    const prisma: any = {
      post: { findFirst: jest.fn(async () => ({ id: 'p1', body: '', hashtags: [], media: [{ r2Key: 'posts/a.jpg', thumbnailR2Key: null }] })) },
      mediaSearchNote: { findMany: jest.fn(async () => []) },
      $executeRaw: jest.fn(async () => 1),
    };
    await make({}, prisma).indexPost('p1');
    expect(prisma.$executeRaw).toHaveBeenCalledTimes(1); // removes any stale vector, nothing is embedded
  });

  it('indexPostIfMissing leaves an existing vector alone', async () => {
    create.mockClear();
    const prisma: any = { $queryRaw: jest.fn(async () => [{ ok: 1 }]), post: { findFirst: jest.fn() } };
    await expect(make({}, prisma).indexPostIfMissing('p1')).resolves.toBe(false);
    expect(prisma.post.findFirst).not.toHaveBeenCalled();
    expect(create).not.toHaveBeenCalled();
  });

  it('removes the vector when a post stops being indexable', async () => {
    const prisma: any = { post: { findFirst: jest.fn(async () => null) }, $executeRaw: jest.fn(async () => 1) };
    await make({}, prisma).indexPost('gone');
    expect(prisma.$executeRaw).toHaveBeenCalledTimes(1);
  });
});

describe('embedding text helpers', () => {
  it('builds stable text and hashes', () => {
    expect(postText(' hi ', ['a', 'b'])).toBe('hi\n#a #b');
    expect(postText('', [], [' A bench ', ''])).toBe('Photo: A bench');
    expect(groupText('Lifters', 'Train together')).toBe('Lifters. Train together');
    expect(userText('Dad of three', ['fitness', 'unknown_topic'])).toContain('Interests:');
    expect(hashText('x')).toBe(hashText('x'));
    expect(hashText('x')).not.toBe(hashText('y'));
  });

  it('round-trips a vector literal', () => {
    expect(parseVector(vectorLiteral([0.5, -1, 2]))).toEqual([0.5, -1, 2]);
    expect(parseVector('not json')).toBeNull();
  });
});

describe('isWorthEmbedding', () => {
  it('skips one-liners and keeps real thoughts', () => {
    const { isWorthEmbedding } = require('./embeddings.service');
    expect(isWorthEmbedding('Amen!')).toBe(false);
    expect(isWorthEmbedding('Amen amen amen amen amen')).toBe(true);
    expect(isWorthEmbedding('🙏🙏🙏🙏🙏🙏🙏🙏🙏🙏🙏🙏🙏🙏🙏🙏🙏🙏🙏🙏🙏🙏🙏🙏🙏')).toBe(false);
    expect(isWorthEmbedding('Anyone tried cold plunges for recovery?')).toBe(true);
    expect(isWorthEmbedding(null)).toBe(false);
  });
});
