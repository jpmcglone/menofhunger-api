import { NotFoundException } from '@nestjs/common';
import { PostsDiscoverMoreService } from './posts-discover-more.service';
import { userNotBannedWhere } from './posts-query-builders';

describe('PostsDiscoverMoreService', () => {
  function makeService(overrides?: {
    seedPost?: Record<string, unknown> | null;
    cachedIds?: string[];
    metaRows?: Array<Record<string, unknown>>;
    followingRows?: Array<Record<string, unknown>>;
    followRows?: Array<{ followingId: string }>;
    topicFollowRows?: Array<{ topic: string }>;
    postViewRows?: Array<{ postId: string }>;
    blockedByViewer?: string[];
    viewerBlockedBy?: string[];
    allowedVisibilities?: Array<'public' | 'verified' | 'premium' | 'premium_plus'>;
  }) {
    const seedPost =
      overrides && 'seedPost' in overrides
        ? overrides.seedPost
        : {
            id: 'seed',
            userId: 'seed-author',
            visibility: 'public',
            communityGroupId: null,
            topics: ['faith'],
            hashtags: ['prayer'],
            rootId: null,
            parentId: null,
          };

    const metaFindMany = jest.fn(async (_args?: unknown) => overrides?.metaRows ?? []);
    const feedFindMany = jest.fn(async (_args?: unknown) => []);
    const followFindMany = jest.fn(async (args?: { where?: { followingId?: { in?: string[] } } }) => {
      // First call in loadFollowedAuthorCandidateRows has no `in`; second is among-authors.
      if (args?.where?.followingId && 'in' in (args.where.followingId as object)) {
        return overrides?.followRows ?? [];
      }
      return (overrides?.followRows ?? []).map((r) => ({ followingId: r.followingId }));
    });
    const topicFollowFindMany = jest.fn(async () => overrides?.topicFollowRows ?? []);
    const postViewFindMany = jest.fn(async (_args?: unknown) => overrides?.postViewRows ?? []);
    const followingCandidateFindMany = jest.fn(async (_args?: unknown) => overrides?.followingRows ?? []);

    const prisma = {
      post: {
        findFirst: jest.fn(async () => seedPost),
        findMany: jest.fn(async (args?: { include?: unknown; where?: Record<string, unknown> }) => {
          // compose path uses include: feedPostInclude
          if (args?.include) return feedFindMany(args);
          // Request-path finds: following-bucket (AND + userId in), then meta filter (id in).
          if (args?.where && 'AND' in args.where) {
            return followingCandidateFindMany(args);
          }
          return metaFindMany(args);
        }),
      },
      follow: { findMany: followFindMany },
      topicFollow: { findMany: topicFollowFindMany },
      postView: { findMany: postViewFindMany },
    };

    const viewerContextService = {
      getViewer: jest.fn(async () => ({ userId: 'viewer' })),
    };
    const enrichment = {
      viewerBlockSets: jest.fn(async () => ({
        blockedByViewer: new Set(overrides?.blockedByViewer ?? []),
        viewerBlockedBy: new Set(overrides?.viewerBlockedBy ?? []),
      })),
      allowedVisibilitiesForViewer: jest.fn(
        () => overrides?.allowedVisibilities ?? (['public'] as const),
      ),
    };
    const feedQuery = {
      assertCanReadCommunityGroup: jest.fn(async () => undefined),
      composeFeedPostDtos: jest.fn(async () => []),
    };
    const cache = {
      getOrSetJson: jest.fn(async ({ compute }: { compute: () => Promise<string[]> }) => {
        if (overrides?.cachedIds) return overrides.cachedIds;
        return compute();
      }),
    };
    const cacheInvalidation = {
      feedGlobalVersion: jest.fn(async () => 1),
    };

    const service = new PostsDiscoverMoreService(
      prisma as any,
      viewerContextService as any,
      enrichment as any,
      feedQuery as any,
      cache as any,
      cacheInvalidation as any,
    );

    return {
      service,
      prisma,
      enrichment,
      metaFindMany,
      postViewFindMany,
    };
  }

  it('throws when seed post is missing', async () => {
    const { service } = makeService({ seedPost: null });
    await expect(
      service.listDiscoverMore({ viewerUserId: 'viewer', postId: 'missing', limit: 8, cursor: null }),
    ).rejects.toBeInstanceOf(NotFoundException);
  });

  it('applies banned + blocked author filters on the viewer meta query', async () => {
    const { service, metaFindMany, enrichment } = makeService({
      cachedIds: ['p1', 'p2', 'p-blocked'],
      blockedByViewer: ['blocked-user'],
      metaRows: [
        {
          id: 'p1',
          userId: 'a1',
          topics: ['faith'],
          hashtags: [],
          trendingScore: 1,
          createdAt: new Date('2026-08-01T00:00:00.000Z'),
        },
      ],
      postViewRows: [{ postId: 'p1' }],
    });

    await service.listDiscoverMore({
      viewerUserId: 'viewer',
      postId: 'seed',
      limit: 8,
      cursor: null,
    });

    expect(enrichment.viewerBlockSets).toHaveBeenCalledWith('viewer');
    expect(metaFindMany).toHaveBeenCalled();
    const metaArgs = metaFindMany.mock.calls[0]?.[0] as { where?: Record<string, unknown> } | undefined;
    expect(metaArgs?.where).toMatchObject({
      ...userNotBannedWhere(),
      userId: { notIn: ['blocked-user'] },
      isDraft: false,
      parentId: null,
      communityGroupId: null,
      deletedAt: null,
    });
  });

  it('loads PostView rows for soft unseen ranking when authenticated', async () => {
    const { service, postViewFindMany } = makeService({
      cachedIds: ['seen', 'unseen'],
      metaRows: [
        {
          id: 'seen',
          userId: 'a1',
          topics: ['faith'],
          hashtags: [],
          trendingScore: 1,
          createdAt: new Date('2026-08-01T00:00:00.000Z'),
        },
        {
          id: 'unseen',
          userId: 'a2',
          topics: ['faith'],
          hashtags: [],
          trendingScore: 1,
          createdAt: new Date('2026-08-01T00:00:00.000Z'),
        },
      ],
      postViewRows: [{ postId: 'seen' }],
    });

    await service.listDiscoverMore({
      viewerUserId: 'viewer',
      postId: 'seed',
      limit: 8,
      cursor: null,
    });

    expect(postViewFindMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          userId: 'viewer',
          postId: { in: expect.arrayContaining(['seen', 'unseen']) },
        }),
      }),
    );
  });

  it('skips PostView + following bucket work for logged-out viewers', async () => {
    const { service, postViewFindMany, enrichment } = makeService({
      cachedIds: ['p1'],
      metaRows: [
        {
          id: 'p1',
          userId: 'a1',
          topics: ['faith'],
          hashtags: [],
          trendingScore: 1,
          createdAt: new Date('2026-08-01T00:00:00.000Z'),
        },
      ],
    });

    await service.listDiscoverMore({
      viewerUserId: null,
      postId: 'seed',
      limit: 8,
      cursor: null,
    });

    expect(enrichment.viewerBlockSets).not.toHaveBeenCalled();
    expect(postViewFindMany).not.toHaveBeenCalled();
  });
});
