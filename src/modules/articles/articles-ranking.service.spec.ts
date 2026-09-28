import { POSTS_RANKING } from '../posts/posts-ranking.config';
import { ArticlesRankingService } from './articles-ranking.service';

function makeService(prismaOverrides: Record<string, any> = {}) {
  const prisma: any = {
    article: {
      findMany: jest.fn(async () => []),
    },
    $queryRaw: jest.fn(async () => []),
    $executeRaw: jest.fn(async () => 0),
    ...prismaOverrides,
  };
  const service = new ArticlesRankingService(prisma);
  return { service, prisma };
}

describe('ArticlesRankingService.ensureArticleBoostScoresFresh', () => {
  it('recomputes and persists weighted scores for stale articles', async () => {
    const findMany = jest.fn(async () => [{ id: 'a1', boostScoreUpdatedAt: null }]);
    const queryRaw: any = jest.fn(async () => [{ articleId: 'a1', score: 5 }]);
    const executeRaw: any = jest.fn(async () => 1);
    const { service } = makeService({
      article: { findMany },
      $queryRaw: queryRaw,
      $executeRaw: executeRaw,
    });

    await service.ensureArticleBoostScoresFresh(['a1']);

    expect(queryRaw).toHaveBeenCalledTimes(1);
    expect(executeRaw).toHaveBeenCalledTimes(1);
    // Verified is 1, everyone else is half, premium (including Premium+) is 1.25.
    const query = queryRaw.mock.calls[0][0] as { strings: string[]; values: unknown[] };
    expect(query.strings.join('')).toContain('WHEN u."premium" THEN');
    expect(query.values).toEqual(
      expect.arrayContaining([
        POSTS_RANKING.boostWeightPremium,
        POSTS_RANKING.boostWeightVerified,
        POSTS_RANKING.boostWeightBase,
      ]),
    );
  });

  it('skips recomputation when scores are still fresh', async () => {
    const findMany = jest.fn(async () => [{ id: 'a1', boostScoreUpdatedAt: new Date() }]);
    const queryRaw = jest.fn(async () => []);
    const executeRaw = jest.fn(async () => 0);
    const { service } = makeService({
      article: { findMany },
      $queryRaw: queryRaw,
      $executeRaw: executeRaw,
    });

    await service.ensureArticleBoostScoresFresh(['a1']);

    expect(queryRaw).not.toHaveBeenCalled();
    expect(executeRaw).not.toHaveBeenCalled();
  });

  it('no-ops on an empty id list', async () => {
    const findMany = jest.fn();
    const { service } = makeService({ article: { findMany } });
    await service.ensureArticleBoostScoresFresh([]);
    expect(findMany).not.toHaveBeenCalled();
  });
});
