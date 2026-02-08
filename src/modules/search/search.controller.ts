import { Controller, Get, Query, Res, UseGuards } from '@nestjs/common';
import { OptionalCurrentUserId } from '../users/users.decorator';
import { z } from 'zod';
import type { Response } from 'express';
import { OptionalAuthGuard } from '../auth/optional-auth.guard';
import { AppConfigService } from '../app/app-config.service';
import type { PostWithAuthorAndMedia } from '../../common/dto/post.dto';
import { toPostDto, toUserListDto } from '../../common/dto';
import { PostsService } from '../posts/posts.service';
import { SearchService, type SearchUserRow } from './search.service';
import { Throttle } from '@nestjs/throttler';
import { rateLimitLimit, rateLimitTtl } from '../../common/throttling/rate-limit.resolver';

const searchSchema = z.object({
  q: z.string().trim().max(200).optional(),
  type: z.enum(['posts', 'users', 'bookmarks', 'all', 'hashtags']).optional(),
  limit: z.coerce.number().int().min(1).max(50).optional(),
  cursor: z.string().optional(),
  userCursor: z.string().optional(),
  postCursor: z.string().optional(),
  collectionId: z.string().trim().min(1).optional(),
  unorganized: z.string().trim().optional(),
});

@UseGuards(OptionalAuthGuard)
@Controller('search')
export class SearchController {
  constructor(
    private readonly search: SearchService,
    private readonly posts: PostsService,
    private readonly appConfig: AppConfigService,
  ) {}

  @Throttle({
    default: {
      limit: rateLimitLimit('search', 120),
      ttl: rateLimitTtl('search', 60),
    },
  })
  @Get()
  async searchAll(
    @OptionalCurrentUserId() userId: string | undefined,
    @Query() query: unknown,
    @Res({ passthrough: true }) httpRes: Response,
  ) {
    const parsed = searchSchema.parse(query);
    const viewerUserId = userId ?? null;

    const type = parsed.type ?? 'posts';
    const limit = parsed.limit ?? 30;
    const cursor = parsed.cursor ?? null;
    const userCursor = parsed.userCursor ?? null;
    const postCursor = parsed.postCursor ?? null;
    const q = (parsed.q ?? '').trim();
    const publicBaseUrl = this.appConfig.r2()?.publicBaseUrl ?? null;

    // Search results include viewer-specific fields (boost/bookmark relationships) when authenticated.
    // Allow short caching only for anonymous reads.
    httpRes.setHeader(
      'Cache-Control',
      viewerUserId ? 'private, max-age=60' : 'public, max-age=30, stale-while-revalidate=60',
    );
    httpRes.setHeader('Vary', 'Cookie');

    if (type === 'hashtags') {
      const res = await this.search.searchHashtags({ q, limit, cursor });
      return { data: res.hashtags, pagination: { nextCursor: res.nextCursor } };
    }

    if (type === 'all') {
      const userLimit = Math.min(10, limit);
      const postLimit = Math.min(20, Math.max(limit - userLimit, 10));
      const res = await this.search.searchMixed({
        viewerUserId,
        q,
        userLimit,
        postLimit,
        userCursor,
        postCursor,
      });
      const users = res.users.map((u) => toUserListDto(u, publicBaseUrl, { relationship: u.relationship, createdAt: u.createdAt }));
      const postIds = (res.posts ?? []).map((p) => p.id);
      const boosted = viewerUserId ? await this.posts.viewerBoostedPostIds({ viewerUserId, postIds }) : new Set<string>();
      const bookmarksByPostId = viewerUserId
        ? await this.posts.viewerBookmarksByPostId({ viewerUserId, postIds })
        : new Map<string, { collectionIds: string[] }>();
      const viewer = await this.posts.viewerContext(viewerUserId);
      const viewerHasAdmin = Boolean(viewer?.siteAdmin);
      const internalByPostId = viewerHasAdmin && postIds.length > 0
        ? await this.posts.ensureBoostScoresFresh(postIds)
        : null;
      const scoreByPostId = viewerHasAdmin && postIds.length > 0
        ? await this.posts.computeScoresForPostIds(postIds)
        : undefined;
      const posts = (res.posts ?? []).map((p) => {
        const base = internalByPostId?.get(p.id);
        const score = scoreByPostId?.get(p.id);
        return toPostDto(p as PostWithAuthorAndMedia, publicBaseUrl, {
          viewerHasBoosted: boosted.has(p.id),
          viewerHasBookmarked: bookmarksByPostId.has(p.id),
          viewerBookmarkCollectionIds: bookmarksByPostId.get(p.id)?.collectionIds ?? [],
          includeInternal: viewerHasAdmin,
          internalOverride:
            base || (typeof score === 'number' ? { score } : undefined)
              ? { ...base, ...(typeof score === 'number' ? { score } : {}) }
              : undefined,
        });
      });
      if (viewerUserId && q.length >= 2) {
        void this.search.recordUserSearch({ userId: viewerUserId, query: q }).catch(() => {});
      }
      return {
        data: { users, posts },
        pagination: { nextUserCursor: res.nextUserCursor, nextPostCursor: res.nextPostCursor },
      };
    }

    if (type === 'users') {
      const result = await this.search.searchUsers({ q, limit, cursor, viewerUserId });
      const users = result.users.map((u) => toUserListDto(u, publicBaseUrl, { relationship: u.relationship, createdAt: u.createdAt }));
      return { data: users, pagination: { nextCursor: result.nextCursor } };
    }
    if (type === 'bookmarks') {
      const collectionId = parsed.collectionId ?? null;
      const unorganized = /^(1|true)$/i.test((parsed.unorganized ?? '').trim());
      const res = await this.search.searchBookmarks({ viewerUserId, q, limit, cursor, collectionId, unorganized });

      const postIds = (res.bookmarks ?? []).map((b) => b.post?.id).filter(Boolean) as string[];
      const boosted = viewerUserId
        ? await this.posts.viewerBoostedPostIds({ viewerUserId, postIds })
        : new Set<string>();
      const bookmarksByPostId = viewerUserId
        ? await this.posts.viewerBookmarksByPostId({ viewerUserId, postIds })
        : new Map<string, { collectionIds: string[] }>();

      const viewer = await this.posts.viewerContext(viewerUserId);
      const viewerHasAdmin = Boolean(viewer?.siteAdmin);
      const internalByPostId = viewerHasAdmin && postIds.length > 0
        ? await this.posts.ensureBoostScoresFresh(postIds)
        : null;
      const scoreByPostId = viewerHasAdmin && postIds.length > 0
        ? await this.posts.computeScoresForPostIds(postIds)
        : undefined;

      const bookmarks = (res.bookmarks ?? []).map((b) => {
        const base = internalByPostId?.get(b.post.id);
        const score = scoreByPostId?.get(b.post.id);
        return {
          bookmarkId: b.bookmarkId,
          createdAt: b.createdAt,
          collectionIds: b.collectionIds ?? [],
          post: toPostDto(b.post as PostWithAuthorAndMedia, this.appConfig.r2()?.publicBaseUrl ?? null, {
            viewerHasBoosted: boosted.has(b.post.id),
            viewerHasBookmarked: bookmarksByPostId.has(b.post.id),
            viewerBookmarkCollectionIds: bookmarksByPostId.get(b.post.id)?.collectionIds ?? [],
            includeInternal: viewerHasAdmin,
            internalOverride:
              base || (typeof score === 'number' ? { score } : undefined)
                ? { ...base, ...(typeof score === 'number' ? { score } : {}) }
                : undefined,
          }),
        };
      });
      return { data: bookmarks, pagination: { nextCursor: res.nextCursor ?? null } };
    }
    // posts
    const res = await this.search.searchPosts({ viewerUserId, q, limit, cursor });
    const postIds = (res.posts ?? []).map((p) => p.id);
    const boosted = viewerUserId ? await this.posts.viewerBoostedPostIds({ viewerUserId, postIds }) : new Set<string>();
    const bookmarksByPostId = viewerUserId
      ? await this.posts.viewerBookmarksByPostId({ viewerUserId, postIds })
      : new Map<string, { collectionIds: string[] }>();

    const viewer = await this.posts.viewerContext(viewerUserId);
    const viewerHasAdmin = Boolean(viewer?.siteAdmin);
    const internalByPostId = viewerHasAdmin && postIds.length > 0
      ? await this.posts.ensureBoostScoresFresh(postIds)
      : null;
    const scoreByPostId = viewerHasAdmin && postIds.length > 0
      ? await this.posts.computeScoresForPostIds(postIds)
      : undefined;

    const posts = (res.posts ?? []).map((p) => {
      const base = internalByPostId?.get(p.id);
      const score = scoreByPostId?.get(p.id);
      return toPostDto(p as PostWithAuthorAndMedia, this.appConfig.r2()?.publicBaseUrl ?? null, {
        viewerHasBoosted: boosted.has(p.id),
        viewerHasBookmarked: bookmarksByPostId.has(p.id),
        viewerBookmarkCollectionIds: bookmarksByPostId.get(p.id)?.collectionIds ?? [],
        includeInternal: viewerHasAdmin,
        internalOverride:
          base || (typeof score === 'number' ? { score } : undefined)
            ? { ...base, ...(typeof score === 'number' ? { score } : {}) }
            : undefined,
      });
    });
    return { data: posts, pagination: { nextCursor: res.nextCursor ?? null } };
  }
}

