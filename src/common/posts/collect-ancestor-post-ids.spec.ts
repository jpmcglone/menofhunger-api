import { collectAncestorPostIds } from './collect-ancestor-post-ids';

describe('collectAncestorPostIds', () => {
  it('returns [] for empty seeds without querying', async () => {
    const prisma = { $queryRaw: jest.fn() };
    await expect(collectAncestorPostIds(prisma, [null, '', undefined])).resolves.toEqual([]);
    expect(prisma.$queryRaw).not.toHaveBeenCalled();
  });

  it('queries unique trimmed seed ids via a recursive CTE', async () => {
    const prisma = {
      $queryRaw: jest.fn(async () => [{ id: 'a' }, { id: 'parent-a' }]),
    };
    const ids = await collectAncestorPostIds(prisma, ['a', ' a ', 'a', null]);
    expect(ids).toEqual(['a', 'parent-a']);
    expect(prisma.$queryRaw).toHaveBeenCalledTimes(1);
  });
});
