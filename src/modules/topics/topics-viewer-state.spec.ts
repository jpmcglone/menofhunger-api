import { TopicsService } from './topics.service';

describe('topic feed viewer state', () => {
  it.each(['topic', 'category'] as const)('preserves viewer actions and pagination in the %s feed', async (kind) => {
    const rows = [{ id: 'first' }, { id: 'second' }];
    const enriched = [{ id: 'first', viewerHasCommented: true, viewerHasBoosted: true, viewerHasBookmarked: true }];
    const service = {
      resolveCategoryKeyOrThrow: jest.fn().mockReturnValue({ key: 'community' }),
      resolveAllowlistedTopicOrThrow: jest.fn().mockReturnValue('Brotherhood'),
      combinedTopicsCached: jest.fn().mockResolvedValue([{ category: 'community', topic: 'Brotherhood' }]),
      viewerContext: { getViewer: jest.fn().mockResolvedValue({ id: 'viewer' }) },
      allowedVisibilitiesForViewer: jest.fn().mockReturnValue(['public', 'verifiedOnly']),
      prisma: { post: { findMany: jest.fn().mockResolvedValue(rows) } },
      posts: { composeFeedPostDtos: jest.fn().mockResolvedValue(enriched) },
    };
    const params = { viewerUserId: 'viewer', limit: 1, cursor: null, topic: 'Brotherhood', category: 'community' };
    const method = kind === 'topic' ? TopicsService.prototype.listTopicPosts : TopicsService.prototype.listCategoryPosts;
    const result = await method.call(service, params);
    expect(result).toEqual({ posts: enriched, nextCursor: 'first' });
    expect(service.posts.composeFeedPostDtos).toHaveBeenCalledWith({
      viewerUserId: 'viewer', filteredPosts: [rows[0]], collapsedItemsByItemId: new Map(),
    });
    expect(service.prisma.post.findMany).toHaveBeenCalledWith(expect.objectContaining({
      where: { AND: expect.arrayContaining([{ deletedAt: null, isDraft: false }, { communityGroupId: null }]) },
      take: 2,
    }));
  });
});
