import { EmbeddingsService, groupText, hashText, parseVector, postText, userText, vectorLiteral } from './embeddings.service';

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
  return new EmbeddingsService(config, prisma);
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

  it('removes the vector when a post stops being indexable', async () => {
    const prisma: any = { post: { findFirst: jest.fn(async () => null) }, $executeRaw: jest.fn(async () => 1) };
    await make({}, prisma).indexPost('gone');
    expect(prisma.$executeRaw).toHaveBeenCalledTimes(1);
  });
});

describe('embedding text helpers', () => {
  it('builds stable text and hashes', () => {
    expect(postText(' hi ', ['a', 'b'])).toBe('hi\n#a #b');
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
