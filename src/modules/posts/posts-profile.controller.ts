import { postReadThrottle } from "./posts-http.policy";
import { Inject } from "@nestjs/common";
import { PostsFeedComposeService } from "./posts-feed-compose.service";
import { PostsFeedProfileService } from "./posts-feed-profile.service";
import { PostsFeedMediaService } from "./posts-feed-media.service";
import { PostsFeedListingsService } from "./posts-feed-listings.service";
import { PostsViewerEnrichmentService } from "./posts-viewer-enrichment.service";
import { PostsRankingService } from "./posts-ranking.service";
import { userListSchema, userMediaListSchema } from "./posts.schemas";
import { isSiteAdminViewer } from "../viewer/site-admin";
import { Controller, Get, Param, Query, Res, UseGuards } from "@nestjs/common";
import { ApiTags } from "@nestjs/swagger";
import { Throttle } from "@nestjs/throttler";
import type { Response } from "express";
import { AuthGuard } from "../auth/auth-public-api";
import { OptionalAuthGuard } from "../auth/auth-public-api";
import { AppConfigService } from "../app/app-config.service";
import { CurrentUserId, OptionalCurrentUserId } from "../users/users.decorator";
import { toPostDto, toPostAuthorDtoFromFeedRow } from "./post.dto";
import { setReadCache } from "../../common/http-cache";
import { CacheInvalidationService } from "../redis/cache-invalidation.service";
import { RedisKeys, stableJsonHash } from "../redis/redis-keys";
import { CacheService } from "../redis/cache.service";
import { CacheTtl } from "../redis/cache-ttl";
import { collapseFeedByRoot } from "../../common/feed-collapse/collapse-by-root";
import { collapseRepostsByCanonical } from "../../common/feed-collapse/collapse-reposts-by-canonical";
import { cursorPageQuerySchema } from "../../common/pagination/cursor-query.schema";

@ApiTags("Feed & Posts")
@Controller("posts")
export class PostsProfileController {
  constructor(
    @Inject(PostsFeedComposeService)
    private readonly postsCompose: Pick<
      PostsFeedComposeService,
      "composeFeedPostDtos"
    >,
    @Inject(PostsFeedProfileService)
    private readonly postsProfile: Pick<
      PostsFeedProfileService,
      "listForUsername"
    >,
    @Inject(PostsFeedMediaService)
    private readonly postsMedia: Pick<
      PostsFeedMediaService,
      "listMediaForUsername"
    >,
    @Inject(PostsFeedListingsService)
    private readonly postsListings: Pick<
      PostsFeedListingsService,
      "listOnlyMe"
    >,
    @Inject(PostsViewerEnrichmentService)
    private readonly postsEnrichment: Pick<
      PostsViewerEnrichmentService,
      "viewerContext"
    >,
    @Inject(PostsRankingService)
    private readonly postsRanking: Pick<
      PostsRankingService,
      "computeScoresForPostIds" | "ensureBoostScoresFresh"
    >,
    private readonly appConfig: AppConfigService,
    private readonly cache: CacheService,
    private readonly cacheInvalidation: CacheInvalidationService,
  ) {}

  @UseGuards(OptionalAuthGuard)
  @Get("user/:username")
  async listForUser(
    @OptionalCurrentUserId() userId: string | undefined,
    @Param("username") username: string,
    @Query() query: unknown,
    @Res({ passthrough: true }) httpRes: Response,
  ) {
    const parsed = userListSchema.parse(query);
    const viewerUserId = userId ?? null;
    const limit = parsed.limit ?? 30;
    const cursor = parsed.cursor ?? null;
    const sort = parsed.sort ?? "new";
    const sortKind = sort === "trending" ? "popular" : sort;

    const anonCache = viewerUserId == null;
    const feedVer = anonCache
      ? await this.cacheInvalidation.feedGlobalVersion()
      : null;
    const paramsHash = anonCache
      ? stableJsonHash({
          endpoint: "posts:user",
          sort: sortKind,
          limit,
          cursor,
          visibility: parsed.visibility ?? "all",
          includeCounts: parsed.includeCounts ?? true,
          topLevelOnly: parsed.topLevelOnly ?? false,
        })
      : null;
    const cacheKey =
      anonCache && feedVer
        ? RedisKeys.anonPostsUser(username, paramsHash!, feedVer)
        : null;

    const out = await this.cache.getOrSetJson({
      enabled: anonCache && Boolean(cacheKey),
      key: cacheKey ?? "",
      ttlSeconds: CacheTtl.anonFeedSeconds,
      compute: async () => {
        const result = await this.postsProfile.listForUsername({
          viewerUserId,
          username,
          limit,
          cursor,
          visibility: parsed.visibility ?? "all",
          includeCounts: parsed.includeCounts ?? true,
          sort: sortKind === "popular" ? "popular" : "new",
          topLevelOnly: parsed.topLevelOnly ?? false,
          includeRestricted: parsed.includeRestricted ?? false,
        });

        const profileAuthorBaseUrl = this.appConfig.r2()?.publicBaseUrl ?? null;
        // Collapse multiple flat reposts of the same original on the profile feed
        // (e.g. a user who reposted the same thing twice after un-reposting).
        const {
          items: profileDedupedPosts,
          repostedByAuthorsByItemId: profileRepostedByAuthors,
          repostedByCountByItemId: profileRepostedByCount,
        } = collapseRepostsByCanonical(result.posts, (p) =>
          toPostAuthorDtoFromFeedRow(p, profileAuthorBaseUrl),
        );
        const {
          items: filteredPostsUser,
          collapsedItemsByItemId: collapsedItemsByItemIdUser,
        } = collapseFeedByRoot(profileDedupedPosts, {
          collapseByRoot: parsed.collapseByRoot ?? false,
          collapseMode: parsed.collapseMode ?? "root",
          prefer: parsed.prefer ?? "reply",
          maxPerRoot: parsed.collapseMaxPerRoot ?? 1,
          getId: (post) => post.id,
          getParentId: (post) => post.parentId ?? null,
          getAuthorPreview: (post) =>
            toPostAuthorDtoFromFeedRow(post, profileAuthorBaseUrl),
        });
        const dtos = await this.postsCompose.composeFeedPostDtos({
          viewerUserId,
          filteredPosts: filteredPostsUser,
          collapsedItemsByItemId: collapsedItemsByItemIdUser,
          includeRestricted: parsed.includeRestricted ?? false,
        });
        const profileDtos = dtos.map((dto) => {
          const profileAuthors = profileRepostedByAuthors.get(dto.id);
          const profileCount = profileRepostedByCount.get(dto.id);
          if (profileAuthors) dto.repostedByAuthors = profileAuthors;
          if (profileCount) dto.repostedByCount = profileCount;
          return dto;
        });
        return {
          data: profileDtos,
          pagination: {
            nextCursor: result.nextCursor,
            counts: result.counts ?? null,
          },
        };
      },
    });

    setReadCache(httpRes, { viewerUserId });
    return out;
  }

  // ─── User media grid ───────────────────────────────────────────────────────

  @UseGuards(OptionalAuthGuard)
  @Throttle(postReadThrottle)
  @Get("user/:username/media")
  async listUserMedia(
    @OptionalCurrentUserId() userId: string | undefined,
    @Param("username") username: string,
    @Query() query: unknown,
  ) {
    const parsed = userMediaListSchema.parse(query);
    const result = await this.postsMedia.listMediaForUsername({
      viewerUserId: userId ?? null,
      username,
      limit: parsed.limit ?? 30,
      cursor: parsed.cursor ?? null,
      visibility: parsed.visibility ?? "all",
      sort: parsed.sort ?? "new",
      includeRestricted: parsed.includeRestricted ?? false,
    });
    return {
      data: result.items,
      pagination: { nextCursor: result.nextCursor },
    };
  }

  @UseGuards(AuthGuard)
  @Get("me/only-me")
  async listOnlyMe(@CurrentUserId() userId: string, @Query() query: unknown) {
    const parsed = cursorPageQuerySchema().parse(query);

    const limit = parsed.limit ?? 30;
    const cursor = parsed.cursor ?? null;
    const res = await this.postsListings.listOnlyMe({ userId, limit, cursor });
    const viewer = await this.postsEnrichment.viewerContext(userId);
    const viewerHasAdmin = isSiteAdminViewer(viewer);
    const internalByPostId = viewerHasAdmin
      ? await this.postsRanking.ensureBoostScoresFresh(
          res.posts.map((p) => p.id),
        )
      : null;
    const scoreByPostIdOnlyMe = viewerHasAdmin
      ? await this.postsRanking.computeScoresForPostIds(
          res.posts.map((p) => p.id),
        )
      : undefined;
    return {
      data: res.posts.map((p) => {
        const pWithPoll = p as {
          user?: { id?: string };
          poll?: { creatorSkippedAt?: Date | null };
        };
        const viewerCreatorSkipped =
          pWithPoll.user?.id === userId &&
          Boolean(pWithPoll.poll?.creatorSkippedAt);
        return toPostDto(p, this.appConfig.r2()?.publicBaseUrl ?? null, {
          viewerHasBoosted: false,
          viewerCreatorSkipped: viewerCreatorSkipped || undefined,
          includeInternal: viewerHasAdmin,
          internalOverride: (() => {
            const base = internalByPostId?.get(p.id);
            const score = scoreByPostIdOnlyMe?.get(p.id);
            return base || (typeof score === "number" ? { score } : undefined)
              ? { ...base, ...(typeof score === "number" ? { score } : {}) }
              : undefined;
          })(),
        });
      }),
      pagination: { nextCursor: res.nextCursor },
    };
  }
}
