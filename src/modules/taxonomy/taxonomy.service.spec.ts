import { BadRequestException } from '@nestjs/common';
import { TaxonomyService } from './taxonomy.service';

function makePrisma(overrides?: Record<string, any>) {
  return {
    taxonomyTerm: {
      findMany: jest.fn(async () => []),
      findUnique: jest.fn(async () => null),
      upsert: jest.fn(async () => ({ id: 'term-1', slug: 'stoicism', label: 'Stoicism', kind: 'topic', status: 'active' })),
      count: jest.fn(async () => 0),
      ...overrides?.taxonomyTerm,
    },
    taxonomyAlias: {
      upsert: jest.fn(async () => ({ id: 'alias-1' })),
      count: jest.fn(async () => 0),
      ...overrides?.taxonomyAlias,
    },
    taxonomyEdge: {
      count: jest.fn(async () => 0),
      ...overrides?.taxonomyEdge,
    },
    taxonomyTermMetric: {
      upsert: jest.fn(async () => ({ termId: 'term-1' })),
      count: jest.fn(async () => 0),
      ...overrides?.taxonomyTermMetric,
    },
    articleTag: {
      groupBy: jest.fn(async () => []),
      count: jest.fn(async () => 0),
      ...overrides?.articleTag,
    },
    hashtag: {
      findMany: jest.fn(async () => []),
      count: jest.fn(async () => 0),
      ...overrides?.hashtag,
    },
    post: {
      count: jest.fn(async () => 0),
      ...overrides?.post,
    },
    userTaxonomyPreference: {
      findMany: jest.fn(async () => []),
      ...overrides?.userTaxonomyPreference,
    },
    $transaction: jest.fn(async (fn: any) => fn({
      userTaxonomyPreference: {
        deleteMany: jest.fn(async () => ({ count: 0 })),
        createMany: jest.fn(async () => ({ count: 0 })),
      },
    })),
    ...overrides,
  } as any;
}

describe('TaxonomyService', () => {
  it('caches empty-query search results for short TTL', async () => {
    const prisma = makePrisma({
      taxonomyTerm: {
        findMany: jest.fn(async () => [
          { id: 't1', slug: 'stoicism', label: 'Stoicism', kind: 'topic', aliases: [{ alias: 'stoic' }], metrics: { engagementScore: 9 } },
        ]),
      },
    });
    const svc = new TaxonomyService(prisma);

    const a = await svc.search({ q: '', limit: 5 });
    const b = await svc.search({ q: '', limit: 5 });

    expect(a).toEqual(b);
    expect(prisma.taxonomyTerm.findMany).toHaveBeenCalledTimes(1);
  });

  it('prioritizes exact slug matches over partial matches', async () => {
    const prisma = makePrisma({
      taxonomyTerm: {
        findMany: jest.fn(async () => [
          { id: 't1', slug: 'stoicism', label: 'Stoicism', kind: 'topic', aliases: [{ alias: 'stoic' }] },
          { id: 't2', slug: 'stoic-practice', label: 'Stoic Practice', kind: 'tag', aliases: [{ alias: 'stoic training' }] },
        ]),
      },
    });
    const svc = new TaxonomyService(prisma);

    const out = await svc.search({ q: 'stoicism', limit: 5 });
    expect(out[0]?.slug).toBe('stoicism');
    expect((out[0]?.score ?? 0)).toBeGreaterThan(out[1]?.score ?? 0);
  });

  it('returns null from getBySlug when term is missing', async () => {
    const prisma = makePrisma({
      taxonomyTerm: { findUnique: jest.fn(async () => null) },
    });
    const svc = new TaxonomyService(prisma);
    await expect(svc.getBySlug('unknown')).resolves.toBeNull();
  });

  it('returns null from getBySlug when term status is hidden', async () => {
    const prisma = makePrisma({
      taxonomyTerm: {
        findUnique: jest.fn(async () => ({ id: 't1', slug: 'stoicism', label: 'Stoicism', kind: 'topic', status: 'hidden', aliases: [] })),
      },
    });
    const svc = new TaxonomyService(prisma);
    await expect(svc.getBySlug('stoicism')).resolves.toBeNull();
  });

  it('maps active getBySlug result to response shape', async () => {
    const prisma = makePrisma({
      taxonomyTerm: {
        findUnique: jest.fn(async () => ({
          id: 't1',
          slug: 'stoicism',
          label: 'Stoicism',
          kind: 'topic',
          status: 'active',
          aliases: [{ alias: 'stoic' }, { alias: 'philosophy' }],
        })),
      },
    });
    const svc = new TaxonomyService(prisma);

    await expect(svc.getBySlug('stoicism')).resolves.toEqual({
      id: 't1',
      slug: 'stoicism',
      label: 'Stoicism',
      kind: 'topic',
      score: 0,
      aliases: ['stoic', 'philosophy'],
    });
  });

  it('rejects setUserPreferences when provided IDs are invalid', async () => {
    const prisma = makePrisma({
      taxonomyTerm: { count: jest.fn(async () => 0) },
    });
    const svc = new TaxonomyService(prisma);

    await expect(svc.setUserPreferences('u1', ['term-a', 'term-b'])).rejects.toThrow(BadRequestException);
  });

  it('setUserPreferences deduplicates IDs before writing', async () => {
    const createMany = jest.fn(async () => ({ count: 1 }));
    const deleteMany = jest.fn(async () => ({ count: 1 }));
    const prisma = makePrisma({
      taxonomyTerm: { count: jest.fn(async () => 1) },
      $transaction: jest.fn(async (fn: any) =>
        fn({ userTaxonomyPreference: { deleteMany, createMany } }),
      ),
      userTaxonomyPreference: {
        findMany: jest.fn(async () => [
          { termId: 'term-a', term: { id: 'term-a', slug: 'stoicism', label: 'Stoicism', kind: 'topic' } },
        ]),
      },
    });
    const svc = new TaxonomyService(prisma);

    await svc.setUserPreferences('u1', ['term-a', 'term-a']);

    expect(deleteMany).toHaveBeenCalledTimes(1);
    expect(createMany).toHaveBeenCalledWith({
      data: [{ userId: 'u1', termId: 'term-a' }],
      skipDuplicates: true,
    });
  });

  it('getUserPreferences returns normalized preference DTOs', async () => {
    const prisma = makePrisma({
      userTaxonomyPreference: {
        findMany: jest.fn(async () => [
          { termId: 't1', term: { id: 't1', slug: 'stoicism', label: 'Stoicism', kind: 'topic' } },
          { termId: 't2', term: { id: 't2', slug: 'fatherhood', label: 'Fatherhood', kind: 'tag' } },
        ]),
      },
    });
    const svc = new TaxonomyService(prisma);

    await expect(svc.getUserPreferences('u1')).resolves.toEqual([
      { termId: 't1', slug: 'stoicism', label: 'Stoicism', kind: 'topic' },
      { termId: 't2', slug: 'fatherhood', label: 'Fatherhood', kind: 'tag' },
    ]);
  });
});
