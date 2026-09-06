import type { Response } from 'express';
import { PostsController } from './posts.controller';
import { PostsFeedQueryService } from './posts-feed-query.service';

describe('quote feed viewer state and access', () => {
  it('uses the shared post composer, preserving every viewer action and embedded post', async () => {
    const raw = [{ id: 'quote' }];
    const enriched = [{ id: 'quote', viewerHasCommented: true, viewerHasBoosted: true, viewerHasBookmarked: true }];
    const posts = {
      listQuotes: jest.fn().mockResolvedValue({ posts: raw, nextCursor: 'next' }),
      composeFeedPostDtos: jest.fn().mockResolvedValue(enriched),
    };
    const response = { setHeader: jest.fn() };
    const result = await PostsController.prototype.listQuotes.call({ posts }, 'viewer', 'original', {}, response as unknown as Response);
    expect(result).toEqual({ data: enriched, pagination: { nextCursor: 'next' } });
    expect(posts.composeFeedPostDtos).toHaveBeenCalledWith({ viewerUserId: 'viewer', filteredPosts: raw, collapsedItemsByItemId: new Map() });
  });

  it('excludes draft quotes and enforces access to each quote’s group', async () => {
    const quotes = [{ id: 'public-quote', createdAt: new Date() }, { id: 'private-group-quote', createdAt: new Date() }];
    const prisma = { post: {
      findFirst: jest.fn().mockResolvedValue({ id: 'original', visibility: 'public' }),
      findMany: jest.fn().mockResolvedValue(quotes),
    } };
    const service = {
      prisma,
      viewerContextService: { getViewer: jest.fn().mockResolvedValue(null) },
      enrichment: { allowedVisibilitiesForViewer: jest.fn().mockReturnValue(['public']) },
      assertReadableCommunityGroupPost: jest.fn(),
      filterPostsByCommunityGroupAccess: jest.fn().mockResolvedValue([quotes[0]]),
    };
    const result = await PostsFeedQueryService.prototype.listQuotes.call(service, { viewerUserId: null, postId: 'original', limit: 20, cursor: null });
    expect(prisma.post.findFirst).toHaveBeenCalledWith(expect.objectContaining({ where: { id: 'original', deletedAt: null, isDraft: false } }));
    expect(prisma.post.findMany).toHaveBeenCalledWith(expect.objectContaining({ where: expect.objectContaining({ isDraft: false, deletedAt: null }) }));
    expect(service.filterPostsByCommunityGroupAccess).toHaveBeenCalledWith({ viewerUserId: null, viewer: null, posts: quotes });
    expect(result.posts).toEqual([quotes[0]]);
  });
});
