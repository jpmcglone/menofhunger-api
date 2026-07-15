/* eslint-disable @typescript-eslint/no-explicit-any */
import { NotFoundException } from '@nestjs/common';
import { readFileSync } from 'fs';
import { resolve } from 'path';
import { PostsFeedQueryService } from '../posts/posts-feed-query.service';
import { PublicProfilesService } from '../users/public-profiles.service';

describe('PostsFeedQueryService.getPublicById', () => {
  function makeService(candidate: Record<string, unknown> | null) {
    const findFirst = jest.fn(async ({ where }: { where: Record<string, unknown> }) => {
      if (!candidate) return null;
      const matches =
        candidate.id === where.id &&
        candidate.deletedAt === where.deletedAt &&
        candidate.isDraft === where.isDraft &&
        candidate.visibility === where.visibility &&
        candidate.communityGroupId === where.communityGroupId;
      return matches ? candidate : null;
    });
    const composeFeedPostDtos = jest.fn(async ({ filteredPosts }) => [
      {
        ...filteredPosts[0],
        media: [{ id: 'media-1', url: 'https://cdn.example/image.jpg' }],
        author: { id: 'user-1', username: 'john' },
      },
    ]);
    const service = Object.create(PostsFeedQueryService.prototype) as any;
    service.prisma = { post: { findFirst } };
    service.composeFeedPostDtos = composeFeedPostDtos;
    return { service, findFirst, composeFeedPostDtos };
  }

  it('returns the shared PostDto composition including author and media', async () => {
    const { service, findFirst, composeFeedPostDtos } = makeService({
      id: 'post-public',
      deletedAt: null,
      isDraft: false,
      visibility: 'public',
      communityGroupId: null,
    });

    const result = await service.getPublicById('post-public');

    expect(result).toEqual(
      expect.objectContaining({
        id: 'post-public',
        media: [expect.objectContaining({ id: 'media-1' })],
        author: expect.objectContaining({ username: 'john' }),
      }),
    );
    expect(findFirst).toHaveBeenCalledWith(
      expect.objectContaining({
        where: {
          id: 'post-public',
          deletedAt: null,
          isDraft: false,
          visibility: 'public',
          communityGroupId: null,
        },
      }),
    );
    expect(composeFeedPostDtos).toHaveBeenCalledWith(
      expect.objectContaining({ viewerUserId: null }),
    );
  });

  it.each([
    ['verified-only', { visibility: 'verifiedOnly' }],
    ['premium-only', { visibility: 'premiumOnly' }],
    ['only-me', { visibility: 'onlyMe' }],
    ['draft', { isDraft: true }],
    ['group', { communityGroupId: 'group-1' }],
    ['deleted', { deletedAt: new Date() }],
  ])('returns 404 for a %s post', async (_label, override) => {
    const { service, composeFeedPostDtos } = makeService({
      id: 'post-hidden',
      deletedAt: null,
      isDraft: false,
      visibility: 'public',
      communityGroupId: null,
      ...override,
    });

    await expect(service.getPublicById('post-hidden')).rejects.toBeInstanceOf(
      NotFoundException,
    );
    expect(composeFeedPostDtos).not.toHaveBeenCalled();
  });
});

describe('PublicProfilesService.getAnonymousProfile', () => {
  it('redacts presence and adds the existing public aggregates', async () => {
    const service = Object.create(PublicProfilesService.prototype) as any;
    service.getByUsernameOrId = jest.fn().mockResolvedValue({
      cache: 'hit',
      payload: {
        id: 'user-1',
        username: 'john',
        lastOnlineAt: '2026-07-15T18:00:00.000Z',
      },
    });
    service.batchOrgAffiliations = jest.fn().mockResolvedValue(
      new Map([['user-1', [{ id: 'org-1', username: 'moh', name: 'MoH', avatarUrl: null }]]]),
    );
    service.prisma = {
      crewMember: { findFirst: jest.fn().mockResolvedValue({ crewId: 'crew-1' }) },
      post: { count: jest.fn().mockResolvedValue(12) },
      article: { count: jest.fn().mockResolvedValue(3) },
    };

    const result = await service.getAnonymousProfile('john');

    expect(result.payload).toEqual(
      expect.objectContaining({
        id: 'user-1',
        lastOnlineAt: null,
        postCount: 12,
        articleCount: 3,
        inCrew: true,
        orgAffiliations: [expect.objectContaining({ id: 'org-1' })],
      }),
    );
  });
});

describe('public API CORS scope', () => {
  it('opens only /v1/public reads to arbitrary browser origins', () => {
    const main = readFileSync(resolve(process.cwd(), 'src/main.ts'), 'utf8');
    expect(main).toContain("app.use('/v1/public'");
    expect(main).toContain("res.setHeader('Access-Control-Allow-Origin', '*')");
    expect(main).toContain("res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS')");
  });
});
