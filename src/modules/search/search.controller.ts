import { Controller, Get, Query, Res, UseGuards } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { OptionalCurrentUserId } from '../users/users.decorator';
import { z } from 'zod';
import type { Response } from 'express';
import { OptionalAuthGuard } from '../auth/optional-auth.guard';
import { AppConfigService } from '../app/app-config.service';
import type { PostWithAuthorAndMedia } from '../../common/dto/post.dto';
import type { ArticleWithAuthor } from '../../common/dto/article.dto';
import { toArticleDto, toPostDto, toUserListDto } from '../../common/dto';
import { PostsService } from '../posts/posts.service';
import { SearchService } from './search.service';
import { Throttle } from '@nestjs/throttler';
import { rateLimitLimit, rateLimitTtl } from '../../common/throttling/rate-limit.resolver';
import { CacheInvalidationService } from '../redis/cache-invalidation.service';
import { RedisKeys, stableJsonHash } from '../redis/redis-keys';
import { CacheService } from '../redis/cache.service';
import { CacheTtl } from '../redis/cache-ttl';
import { PosthogService } from '../../common/posthog/posthog.service';
import { TaxonomyService } from '../taxonomy/taxonomy.service';

const searchSchema = z.object({
  q: z.string().trim().max(200).optional(),
  type: z.enum(['posts', 'users', 'bookmarks', 'all', 'hashtags', 'taxonomy']).optional(),
  // Source hint for analytics/search-history recording.
  source: z.enum(['explore', 'external']).optional(),
  // Posts-only: filter by kind (e.g. allow "check-ins only" in search UI)
  kind: z.enum(['regular', 'checkin']).optional(),
  limit: z.coerce.number().int().min(1).max(50).optional(),
  cursor: z.string().optional(),
  userCursor: z.string().optional(),
  postCursor: z.string().optional(),
  articleCursor: z.string().optional(),
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
    private readonly cache: CacheService,
    private readonly cacheInvalidation: CacheInvalidationService,
    private readonly posthog: PosthogService,
    private readonly taxonomy: TaxonomyService,
    private readonly prisma: PrismaService,
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
    const articleCursor = parsed.articleCursor ?? null;
    const kind = parsed.kind ?? null;
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
    if (type === 'taxonomy') {
      const data = await this.taxonomy.search({ q, limit });
      return { data, pagination: { nextCursor: null } };
    }

    if (type === 'all') {
      const userLimit = Math.min(10, Math.ceil(limit * 0.35));
      const groupLimit = Math.min(8, Math.ceil(limit * 0.27));
      const remainder = Math.max(0, limit - userLimit - groupLimit);
      const articleLimit = Math.min(10, Math.max(Math.floor(remainder / 2), 1));
      const postLimit = Math.min(20, Math.max(remainder - articleLimit, 1));
      const res = await this.search.searchMixed({
        viewerUserId,
        q,
        userLimit,
        postLimit,
        articleLimit,
        groupLimit,
        userCursor,
        postCursor,
        articleCursor,
        kind,
      });
      const users = res.users.map((u) =>
        toUserListDto(u, publicBaseUrl, {
          relationship: {
            viewerFollowsUser: u.relationship.viewerFollowsUser,
            userFollowsViewer: u.relationship.userFollowsViewer,
            viewerPostNotificationsEnabled: (u.relationship as any).viewerPostNotificationsEnabled ?? false,
          },
          createdAt: u.createdAt,
        }),
      );
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
      const groupIds = [
        ...new Set(
          (res.posts ?? [])
            .map((p) => String((p as { communityGroupId?: string | null }).communityGroupId ?? '').trim())
            .filter(Boolean),
        ),
      ];
      const groupPreviewById = await this.posts.communityGroupPreviewMapForFeed(viewerUserId, groupIds);
      const posts = (res.posts ?? []).map((p) => {
        const base = internalByPostId?.get(p.id);
        const score = scoreByPostId?.get(p.id);
        const gid = String((p as { communityGroupId?: string | null }).communityGroupId ?? '').trim();
        const gp = gid ? groupPreviewById.get(gid) : undefined;
        return toPostDto(p as PostWithAuthorAndMedia, publicBaseUrl, {
          viewerHasBoosted: boosted.has(p.id),
          viewerHasBookmarked: bookmarksByPostId.has(p.id),
          viewerBookmarkCollectionIds: bookmarksByPostId.get(p.id)?.collectionIds ?? [],
          includeInternal: viewerHasAdmin,
          internalOverride:
            base || (typeof score === 'number' ? { score } : undefined)
              ? { ...base, ...(typeof score === 'number' ? { score } : {}) }
              : undefined,
          ...(gp ? { groupPreview: gp } : {}),
        });
      });
      const articles = (res.articles ?? []).map((a) =>
        toArticleDto(a as unknown as ArticleWithAuthor, publicBaseUrl, {
          viewerUserId,
          viewerCanAccess: a.viewerCanAccess,
        }),
      );
      const groups = res.groups ?? [];
      const taxonomyMatches = q.length >= 2
        ? await this.taxonomy.search({ q, limit: Math.min(8, limit) })
        : [];
      if (viewerUserId && q.length >= 2 && parsed.source === 'explore') {
        void this.search.recordUserSearch({ userId: viewerUserId, query: q }).catch(() => {});
        this.posthog.capture(viewerUserId, 'search_performed', {
          query: q.toLowerCase(),
          result_count: users.length + posts.length + articles.length + groups.length + taxonomyMatches.length,
          type,
        });
      }
      return {
        data: { users, posts, articles, groups, taxonomyMatches },
        pagination: {
          nextUserCursor: res.nextUserCursor,
          nextPostCursor: res.nextPostCursor,
          nextArticleCursor: res.nextArticleCursor,
        },
      };
    }

    if (type === 'users') {
      const result = await this.search.searchUsers({ q, limit, cursor, viewerUserId });
      const userIds = result.users.map((u) => u.id);
      const crewMembers = userIds.length
        ? await this.prisma.crewMember.findMany({
            where: { userId: { in: userIds }, crew: { deletedAt: null } },
            select: { userId: true, crew: { select: { memberCount: true } } },
          })
        : [];
      // `inCrew` here means "in a crew that blocks new invites." A solo crew
      // member (memberCount === 1, just themselves) is treated as inviteable —
      // accepting an invite to another crew auto-disbands their old crew. So
      // the picker should NOT grey them out.
      const inCrewIds = new Set(
        crewMembers.filter((m) => m.crew.memberCount > 1).map((m) => m.userId),
      );
      const users = result.users.map((u) => ({
        ...toUserListDto(u, publicBaseUrl, {
          relationship: {
            viewerFollowsUser: u.relationship.viewerFollowsUser,
            userFollowsViewer: u.relationship.userFollowsViewer,
            viewerPostNotificationsEnabled: (u.relationship as any).viewerPostNotificationsEnabled ?? false,
          },
          createdAt: u.createdAt,
        }),
        inCrew: inCrewIds.has(u.id),
      }));
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

      const groupIds = [
        ...new Set(
          (res.bookmarks ?? [])
            .map((b) => String((b.post as { communityGroupId?: string | null }).communityGroupId ?? '').trim())
            .filter(Boolean),
        ),
      ];
      const groupPreviewById = new Map<string, Awaited<ReturnType<PostsService['communityGroupPreviewForGroup']>>>();
      await Promise.all(
        groupIds.map(async (gid) => {
          const prev = await this.posts.communityGroupPreviewForGroup(gid, viewerUserId);
          if (prev) groupPreviewById.set(gid, prev);
        }),
      );

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
        const gid = String((b.post as { communityGroupId?: string | null }).communityGroupId ?? '').trim();
        const gp = gid ? groupPreviewById.get(gid) : undefined;
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
            ...(gp ? { groupPreview: gp } : {}),
          }),
        };
      });
      return { data: bookmarks, pagination: { nextCursor: res.nextCursor ?? null } };
    }
    // posts
    const anonCache = viewerUserId == null;
    const searchVer = anonCache ? await this.cacheInvalidation.searchGlobalVersion() : null;
    const paramsHash = anonCache
      ? stableJsonHash({
          endpoint: 'search:posts',
          q,
          limit,
          cursor,
        })
      : null;
    const cacheKey = anonCache && searchVer ? RedisKeys.anonSearch(paramsHash!, searchVer) : null;

    const out = await this.cache.getOrSetJson<{ data: any; pagination: any }>({
      enabled: anonCache && Boolean(cacheKey),
      key: cacheKey ?? '',
      ttlSeconds: CacheTtl.anonSearchPostsSeconds,
      compute: async () => {
        const res = await this.search.searchPosts({ viewerUserId, q, limit, cursor, kind });
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

        const searchGroupIds = [
          ...new Set(
            (res.posts ?? [])
              .map((p) => String((p as { communityGroupId?: string | null }).communityGroupId ?? '').trim())
              .filter(Boolean),
          ),
        ];
        const groupPreviewById = await this.posts.communityGroupPreviewMapForFeed(viewerUserId, searchGroupIds);

        const posts = (res.posts ?? []).map((p) => {
          const base = internalByPostId?.get(p.id);
          const score = scoreByPostId?.get(p.id);
          const gid = String((p as { communityGroupId?: string | null }).communityGroupId ?? '').trim();
          const gp = gid ? groupPreviewById.get(gid) : undefined;
          return toPostDto(p as PostWithAuthorAndMedia, this.appConfig.r2()?.publicBaseUrl ?? null, {
            viewerHasBoosted: boosted.has(p.id),
            viewerHasBookmarked: bookmarksByPostId.has(p.id),
            viewerBookmarkCollectionIds: bookmarksByPostId.get(p.id)?.collectionIds ?? [],
            includeInternal: viewerHasAdmin,
            internalOverride:
              base || (typeof score === 'number' ? { score } : undefined)
                ? { ...base, ...(typeof score === 'number' ? { score } : {}) }
                : undefined,
            ...(gp ? { groupPreview: gp } : {}),
          });
        });
        return { data: posts, pagination: { nextCursor: res.nextCursor ?? null } };
      },
    });
    return out;
  }
}

