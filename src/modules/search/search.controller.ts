import { Controller, Get, Query, Req, UseGuards } from '@nestjs/common';
import type { Request } from 'express';
import { z } from 'zod';
import { OptionalAuthGuard } from '../auth/optional-auth.guard';
import { AppConfigService } from '../app/app-config.service';
import { toPostDto } from '../posts/post.dto';
import { PostsService } from '../posts/posts.service';
import { SearchService } from './search.service';
import { Throttle } from '@nestjs/throttler';
import { rateLimitLimit, rateLimitTtl } from '../../common/throttling/rate-limit.resolver';

const searchSchema = z.object({
  q: z.string().trim().max(200).optional(),
  type: z.enum(['posts', 'users', 'bookmarks']).optional(),
  limit: z.coerce.number().int().min(1).max(50).optional(),
  cursor: z.string().optional(),
  collectionId: z.string().trim().min(1).optional(),
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
  async searchAll(@Req() req: Request, @Query() query: unknown) {
    const parsed = searchSchema.parse(query);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const viewerUserId = ((req as any).user?.id as string | undefined) ?? null;

    const type = parsed.type ?? 'posts';
    const limit = parsed.limit ?? 30;
    const cursor = parsed.cursor ?? null;
    const q = (parsed.q ?? '').trim();

    if (type === 'users') {
      return await this.search.searchUsers({ q, limit, cursor });
    }
    if (type === 'bookmarks') {
      const collectionId = parsed.collectionId ?? null;
      const res = await this.search.searchBookmarks({ viewerUserId, q, limit, cursor, collectionId });

      const postIds = (res.bookmarks ?? []).map((b) => b.post?.id).filter(Boolean) as string[];
      const boosted = viewerUserId
        ? await this.posts.viewerBoostedPostIds({ viewerUserId, postIds })
        : new Set<string>();
      const bookmarksByPostId = viewerUserId
        ? await this.posts.viewerBookmarksByPostId({ viewerUserId, postIds })
        : new Map<string, { collectionId: string | null }>();

      return {
        bookmarks: (res.bookmarks ?? []).map((b) => ({
          bookmarkId: b.bookmarkId,
          createdAt: b.createdAt,
          collectionId: b.collectionId ?? null,
          post: toPostDto(b.post as any, this.appConfig.r2()?.publicBaseUrl ?? null, {
            viewerHasBoosted: boosted.has(b.post.id),
            viewerHasBookmarked: bookmarksByPostId.has(b.post.id),
            viewerBookmarkCollectionId: bookmarksByPostId.get(b.post.id)?.collectionId ?? null,
          }),
        })),
        nextCursor: res.nextCursor ?? null,
      };
    }
    // posts
    const res = await this.search.searchPosts({ viewerUserId, q, limit, cursor });
    const postIds = (res.posts ?? []).map((p) => p.id);
    const boosted = viewerUserId ? await this.posts.viewerBoostedPostIds({ viewerUserId, postIds }) : new Set<string>();
    const bookmarksByPostId = viewerUserId
      ? await this.posts.viewerBookmarksByPostId({ viewerUserId, postIds })
      : new Map<string, { collectionId: string | null }>();
    return {
      posts: (res.posts ?? []).map((p) =>
        toPostDto(p as any, this.appConfig.r2()?.publicBaseUrl ?? null, {
          viewerHasBoosted: boosted.has(p.id),
          viewerHasBookmarked: bookmarksByPostId.has(p.id),
          viewerBookmarkCollectionId: bookmarksByPostId.get(p.id)?.collectionId ?? null,
        }),
      ),
      nextCursor: res.nextCursor ?? null,
    };
  }
}

