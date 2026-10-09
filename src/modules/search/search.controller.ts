import { Inject } from '@nestjs/common';
import { PostsViewerEnrichmentService } from '../posts/posts-viewer-enrichment.service';
import { PostsRankingService } from '../posts/posts-ranking.service';
import { PostsFeedComposeService } from '../posts/posts-feed-compose.service';
import { PostsFeedListingsService } from '../posts/posts-feed-listings.service';
import { Body, Controller, Delete, Get, Param, Post, Query, Res, UseGuards } from '@nestjs/common';
import { RecentSearchesService } from './recent-searches.service';
import { ArticleViewsService } from '../article-views/article-views.service';
import { OptionalCurrentUserId, CurrentUserId } from '../users/users.decorator';
import { z } from 'zod';
import type { Response } from 'express';
import { OptionalAuthGuard } from '../auth/auth-public-api';
import { AuthGuard } from '../auth/auth-public-api';
import { AppConfigService } from '../app/app-config.service';
import type { PostWithAuthorAndMedia } from '../../common/dto/post.dto';
import type { ArticleWithAuthor } from '../../common/dto/article.dto';
import { toArticleDto, toPostDto, toUserListDto } from '../../common/dto';

import { SearchService } from './search.service';
import { Throttle } from '@nestjs/throttler';
import { rateLimitLimit, rateLimitTtl } from '../../common/throttling/rate-limit.resolver';
import { CacheInvalidationService } from '../redis/cache-invalidation.service';
import { RedisKeys, stableJsonHash } from '../redis/redis-keys';
import { CacheService } from '../redis/cache.service';
import { CacheTtl } from '../redis/cache-ttl';
import { PosthogService } from '../../common/posthog/posthog.service';
import { TaxonomyService } from '../taxonomy/taxonomy.service';
import { searchSchema } from './search.schemas';

@UseGuards(OptionalAuthGuard)
@Controller('search')
export class SearchController {
  constructor(
    private readonly search: SearchService,
    @Inject(PostsViewerEnrichmentService) private readonly postsEnrichment: Pick<PostsViewerEnrichmentService, 'viewerBoostedPostIds' | 'viewerBookmarksByPostId' | 'viewerContext'>,
    @Inject(PostsRankingService) private readonly postsRanking: Pick<PostsRankingService, 'ensureBoostScoresFresh' | 'computeScoresForPostIds'>,
    @Inject(PostsFeedComposeService) private readonly postsCompose: Pick<PostsFeedComposeService, 'communityGroupPreviewMapForFeed'>,
    @Inject(PostsFeedListingsService) private readonly postsListings: Pick<PostsFeedListingsService, 'communityGroupPreviewForGroup'>,
    private readonly appConfig: AppConfigService,
    private readonly cache: CacheService,
    private readonly cacheInvalidation: CacheInvalidationService,
    private readonly posthog: PosthogService,
    private readonly taxonomy: TaxonomyService,
    private readonly recentSearches: RecentSearchesService,
    private readonly articleViews: ArticleViewsService,
  ) {}

  private async toSearchArticleDtos(
    articles: Array<ArticleWithAuthor & { viewerCanAccess?: boolean }>,
    viewerUserId: string | null,
    publicBaseUrl: string | null,
  ) {
    const viewed = await this.articleViews.viewerViewedArticleIds(
      viewerUserId,
      articles.map((a) => a.id),
    );
    return articles.map((a) =>
      toArticleDto(a, publicBaseUrl, {
        viewerUserId,
        viewerCanAccess: a.viewerCanAccess,
        viewerHasViewed: viewerUserId ? viewed.has(a.id) : undefined,
      }),
    );
  }

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
    if (type === 'cashtags') {
      const res = await this.search.searchCashtags({ q, limit });
      return { data: res.cashtags, pagination: { nextCursor: res.nextCursor } };
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

      // Cache anonymous mixed search results to avoid 5 parallel sub-searches on every
      // unauthenticated explore page load. Versioned key is bumped on every post write.
      // Pagination cursors bypass the cache since they're viewer-session specific.
      const anonMixedCache = viewerUserId == null && !userCursor && !postCursor && !articleCursor;
      const mixedSearchVer = anonMixedCache ? await this.cacheInvalidation.searchGlobalVersion() : null;
      const mixedParamsHash = anonMixedCache
        ? stableJsonHash({ endpoint: 'search:all', q, limit, kind })
        : null;
      const mixedCacheKey =
        anonMixedCache && mixedSearchVer ? RedisKeys.anonSearch(mixedParamsHash!, mixedSearchVer) : null;

      const buildMixedResponse = async () => {
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
              viewerPostNotificationsEnabled: u.relationship.viewerPostNotificationsEnabled ?? false,
              viewerNotificationPreference: u.relationship?.viewerNotificationPreference,
            },
            createdAt: u.createdAt,
          }),
        );
        const postIds = (res.posts ?? []).map((p) => p.id);
        const boosted = viewerUserId ? await this.postsEnrichment.viewerBoostedPostIds({ viewerUserId, postIds }) : new Set<string>();
        const bookmarksByPostId = viewerUserId
          ? await this.postsEnrichment.viewerBookmarksByPostId({ viewerUserId, postIds })
          : new Map<string, { collectionIds: string[] }>();
        const viewerCtx = await this.postsEnrichment.viewerContext(viewerUserId);
        const viewerHasAdmin = Boolean(viewerCtx?.siteAdmin);
        const internalByPostId = viewerHasAdmin && postIds.length > 0
          ? await this.postsRanking.ensureBoostScoresFresh(postIds)
          : null;
        const scoreByPostId = viewerHasAdmin && postIds.length > 0
          ? await this.postsRanking.computeScoresForPostIds(postIds)
          : undefined;
        const groupIds = [
          ...new Set(
            (res.posts ?? [])
              .map((p) => String((p as { communityGroupId?: string | null }).communityGroupId ?? '').trim())
              .filter(Boolean),
          ),
        ];
        const groupPreviewById = await this.postsCompose.communityGroupPreviewMapForFeed(viewerUserId, groupIds);
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
        const articles = await this.toSearchArticleDtos(res.articles ?? [], viewerUserId, publicBaseUrl);
        const groups = res.groups ?? [];
        const taxonomyMatches = q.length >= 2
          ? await this.taxonomy.search({ q, limit: Math.min(8, limit) })
          : [];
        return {
          data: { users, posts, articles, groups, taxonomyMatches, gatedResultCount: res.gatedResultCount },
          pagination: {
            nextUserCursor: res.nextUserCursor,
            nextPostCursor: res.nextPostCursor,
            nextArticleCursor: res.nextArticleCursor,
          },
        };
      };

      const mixedOut = await this.cache.getOrSetJson<{ data: any; pagination: any }>({
        enabled: anonMixedCache && Boolean(mixedCacheKey),
        key: mixedCacheKey ?? '',
        ttlSeconds: CacheTtl.anonSearchPostsSeconds,
        compute: buildMixedResponse,
      });

      if (viewerUserId && q.length >= 2 && parsed.record && (parsed.source === 'explore' || parsed.source === 'external')) {
        void this.search.recordUserSearch({ userId: viewerUserId, query: q }).catch(() => {});
        this.posthog.capture(viewerUserId, 'search_performed', {
          query: q.toLowerCase(),
          result_count: (mixedOut.data.users?.length ?? 0) + (mixedOut.data.posts?.length ?? 0) +
            (mixedOut.data.articles?.length ?? 0) + (mixedOut.data.groups?.length ?? 0),
          type,
          source: parsed.source,
        });
      }
      return mixedOut;
    }

    if (type === 'articles') {
      const res = await this.search.searchArticles({ viewerUserId, q, limit, cursor });
      const articles = await this.toSearchArticleDtos(res.articles ?? [], viewerUserId, publicBaseUrl);
      return { data: articles, pagination: { nextCursor: res.nextCursor } };
    }

    if (type === 'users') {
      const result = await this.search.searchUsers({ q, limit, cursor, viewerUserId });
      const userIds = result.users.map((u) => u.id);
      const inCrewIds = await this.search.inviteBlockingCrewMemberIds(userIds);
      const users = result.users.map((u) => ({
        ...toUserListDto(u, publicBaseUrl, {
          relationship: {
            viewerFollowsUser: u.relationship.viewerFollowsUser,
            userFollowsViewer: u.relationship.userFollowsViewer,
            viewerPostNotificationsEnabled: u.relationship.viewerPostNotificationsEnabled ?? false,
              viewerNotificationPreference: u.relationship?.viewerNotificationPreference,
          },
          createdAt: u.createdAt,
        }),
        inCrew: inCrewIds.has(u.id),
      }));
      return { data: users, pagination: { nextCursor: result.nextCursor } };
    }
    if (type === 'groups') {
      const res = await this.search.searchCommunityGroups({ viewerUserId, q, limit });
      return { data: res.groups, pagination: { nextCursor: null } };
    }

    if (type === 'bookmarks') {
      const collectionId = parsed.collectionId ?? null;
      const unorganized = /^(1|true)$/i.test((parsed.unorganized ?? '').trim());
      const res = await this.search.searchBookmarks({ viewerUserId, q, limit, cursor, collectionId, unorganized });

      const postIds = (res.bookmarks ?? []).map((b) => b.post?.id).filter(Boolean) as string[];
      const boosted = viewerUserId
        ? await this.postsEnrichment.viewerBoostedPostIds({ viewerUserId, postIds })
        : new Set<string>();
      const bookmarksByPostId = viewerUserId
        ? await this.postsEnrichment.viewerBookmarksByPostId({ viewerUserId, postIds })
        : new Map<string, { collectionIds: string[] }>();

      const groupIds = [
        ...new Set(
          (res.bookmarks ?? [])
            .map((b) => String((b.post as { communityGroupId?: string | null }).communityGroupId ?? '').trim())
            .filter(Boolean),
        ),
      ];
      const groupPreviewById = new Map<string, Awaited<ReturnType<PostsFeedListingsService['communityGroupPreviewForGroup']>>>();
      await Promise.all(
        groupIds.map(async (gid) => {
          const prev = await this.postsListings.communityGroupPreviewForGroup(gid, viewerUserId);
          if (prev) groupPreviewById.set(gid, prev);
        }),
      );

      const viewer = await this.postsEnrichment.viewerContext(viewerUserId);
      const viewerHasAdmin = Boolean(viewer?.siteAdmin);
      const internalByPostId = viewerHasAdmin && postIds.length > 0
        ? await this.postsRanking.ensureBoostScoresFresh(postIds)
        : null;
      const scoreByPostId = viewerHasAdmin && postIds.length > 0
        ? await this.postsRanking.computeScoresForPostIds(postIds)
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
        const boosted = viewerUserId ? await this.postsEnrichment.viewerBoostedPostIds({ viewerUserId, postIds }) : new Set<string>();
        const bookmarksByPostId = viewerUserId
          ? await this.postsEnrichment.viewerBookmarksByPostId({ viewerUserId, postIds })
          : new Map<string, { collectionIds: string[] }>();

        const viewer = await this.postsEnrichment.viewerContext(viewerUserId);
        const viewerHasAdmin = Boolean(viewer?.siteAdmin);
        const internalByPostId = viewerHasAdmin && postIds.length > 0
          ? await this.postsRanking.ensureBoostScoresFresh(postIds)
          : null;
        const scoreByPostId = viewerHasAdmin && postIds.length > 0
          ? await this.postsRanking.computeScoresForPostIds(postIds)
          : undefined;

        const searchGroupIds = [
          ...new Set(
            (res.posts ?? [])
              .map((p) => String((p as { communityGroupId?: string | null }).communityGroupId ?? '').trim())
              .filter(Boolean),
          ),
        ];
        const groupPreviewById = await this.postsCompose.communityGroupPreviewMapForFeed(viewerUserId, searchGroupIds);

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

  @UseGuards(AuthGuard)
  @Throttle({
    default: {
      limit: rateLimitLimit('search', 60),
      ttl: rateLimitTtl('search', 60),
    },
  })
  @Get('recent')
  async getRecentSearches(@CurrentUserId() userId: string) {
    const publicBaseUrl = this.appConfig.r2()?.publicBaseUrl ?? null;
    const unique = await this.recentSearches.listRecent(userId);

    return {
      data: unique.map((r) => ({
        id: r.id,
        query: r.query,
        createdAt: r.createdAt.toISOString(),
        user: r.targetUser ? toUserListDto(r.targetUser, publicBaseUrl) : null,
        group: r.targetGroup
          ? { id: r.targetGroup.id, slug: r.targetGroup.slug, name: r.targetGroup.name, avatarImageUrl: r.targetGroup.avatarImageUrl, memberCount: r.targetGroup.memberCount }
          : null,
      })),
    };
  }

  @UseGuards(AuthGuard)
  @Throttle({
    default: {
      limit: rateLimitLimit('interact', 30),
      ttl: rateLimitTtl('interact', 60),
    },
  })
  @Post('recent')
  async recordRecentSearch(
    @CurrentUserId() userId: string,
    @Body() body: unknown,
  ) {
    const schema = z.object({
      query: z.string().trim().max(200).optional(),
      userId: z.string().trim().optional(),
      groupId: z.string().trim().optional(),
    }).refine((d) => Boolean(d.query?.trim() || d.userId?.trim() || d.groupId?.trim()), {
      message: 'At least one of query, userId, or groupId is required',
    });
    const parsed = schema.parse(body);
    const targetUserId = parsed.userId ?? null;
    const targetGroupId = parsed.groupId ?? null;
    const query = (parsed.query ?? '').trim();

    const resolvedQuery = await this.recentSearches.resolveDisplayQuery({ query, targetUserId, targetGroupId });
    await this.search.recordUserSearch({ userId, query: resolvedQuery, targetUserId, targetGroupId });
    return { data: { recorded: true } };
  }

  @UseGuards(AuthGuard)
  @Throttle({
    default: {
      limit: rateLimitLimit('interact', 30),
      ttl: rateLimitTtl('interact', 60),
    },
  })
  @Delete('recent/:id')
  async deleteRecentSearch(@CurrentUserId() userId: string, @Param('id') id: string) {
    await this.recentSearches.deleteRecent(userId, id.trim());
    return { data: { deleted: true } };
  }

  @UseGuards(AuthGuard)
  @Throttle({
    default: {
      limit: rateLimitLimit('interact', 30),
      ttl: rateLimitTtl('interact', 60),
    },
  })
  @Delete('recent')
  async clearRecentSearches(@CurrentUserId() userId: string) {
    await this.recentSearches.clearRecent(userId);
    return { data: { cleared: true } };
  }
}

