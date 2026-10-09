import { PostsReadService } from './posts-read.service';

function setup() {
  const rows = [
    { id: 'active', deletedAt: null, isDraft: false },
    { id: 'draft', deletedAt: null, isDraft: true },
    { id: 'deleted', deletedAt: new Date(), isDraft: false },
  ];
  const post = {
    findMany: jest.fn(async (args) => rows.filter(row => args.where?.deletedAt === null ? row.deletedAt === null : true)),
    findFirst: jest.fn(async () => rows[0]),
    findUnique: jest.fn(async () => rows[2]),
    count: jest.fn(async () => 2),
    aggregate: jest.fn(async () => ({ _sum: { boostCount: 2 } })),
    groupBy: jest.fn(async () => [{ userId: 'user', _count: { _all: 2 } }]),
  };
  return { service: new PostsReadService({ post } as never), post, rows };
}

describe('PostsReadService ownership', () => {
  it('cannot let a caller override active-row filtering and retains private draft queries', async () => {
    const { service, post } = setup();
    const rows = await service.findMany({ where: { deletedAt: { not: null }, userId: 'owner' }, select: { id: true } });
    expect(rows.map(row => row.id)).toEqual(['active', 'draft']);
    expect(post.findMany.mock.calls[0][0].where).toEqual({ deletedAt: null, userId: 'owner' });
    // Selected return shapes remain typed, rather than widening to a raw Post or any.
    // @ts-expect-error body was not selected
    const unselectedBody = rows[0].body;
    void unselectedBody;
  });

  it.each(['findFirst', 'findUnique', 'count', 'aggregate', 'commentCountsByRoot'] as const)('enforces active rows for %s', async method => {
    const { service, post } = setup();
    if (method === 'findFirst') await service.findFirst({ where: { id: 'active' } });
    if (method === 'findUnique') await service.findUnique({ where: { id: 'active' } });
    if (method === 'count') await service.count({ where: { userId: 'owner' } });
    if (method === 'aggregate') await service.aggregate({ _sum: { boostCount: true } });
    if (method === 'commentCountsByRoot') await service.commentCountsByRoot({ rootId: 'root' });
    expect(post[method === 'commentCountsByRoot' ? 'groupBy' : method]).toHaveBeenCalledWith(expect.objectContaining({ where: expect.objectContaining({ deletedAt: null }) }));
  });

  it('exposes explicit tombstone hydration and cursor lookup without active filtering', async () => {
    const { service, post } = setup();
    await expect(service.findManyIncludingDeleted({ where: { id: { in: ['active', 'deleted'] } } })).resolves.toHaveLength(3);
    await service.findIncludingDeleted({ where: { id: 'deleted' }, select: { id: true, createdAt: true } });
    expect(post.findMany).toHaveBeenCalledWith({ where: { id: { in: ['active', 'deleted'] } } });
    expect(post.findUnique).toHaveBeenCalledWith({ where: { id: 'deleted' }, select: { id: true, createdAt: true } });
  });
});
