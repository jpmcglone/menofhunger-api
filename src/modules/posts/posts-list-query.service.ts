import { Inject } from '@nestjs/common';
import { PostsFeedListingsService } from './posts-feed-listings.service';
import { PostsFeedForYouService } from './posts-feed-for-you.service';
import { PostsFeedFeaturedService } from './posts-feed-featured.service';
import { PostsFeedPopularService } from './posts-feed-popular.service';
import { PostsFeedComposeService } from './posts-feed-compose.service';
import { Injectable, Logger } from "@nestjs/common";

import { AppConfigService } from "../app/app-config.service";
import { CacheService } from "../redis/cache.service";
import { CacheInvalidationService } from "../redis/cache-invalidation.service";
import { ForbiddenException } from "@nestjs/common";
import { z } from "zod";
import type { Response } from "express";
import { setReadCache } from "../../common/http-cache";
import { RedisKeys, stableJsonHash } from "../redis/redis-keys";
import { CacheTtl } from "../redis/cache-ttl";
import { collapseFeedByRoot } from "../../common/feed-collapse/collapse-by-root";
import { collapseRepostsByCanonical } from "../../common/feed-collapse/collapse-reposts-by-canonical";
import { queryBoolean } from "../../common/validation/query-boolean";
import { toPostAuthorDtoFromFeedRow } from "./post.dto";
import { cursorPageQuerySchema } from "../../common/pagination/cursor-query.schema";

export const listSchema = cursorPageQuerySchema().extend({
  visibility: z
    .enum(["all", "public", "verifiedOnly", "premiumOnly"])
    .optional(),
  followingOnly: queryBoolean().optional(),
  mediaOnly: queryBoolean().optional(),
  kind: z.enum(["regular", "checkin"]).optional(),
  /** Filter check-ins to a specific ET day (YYYY-MM-DD). Forces kind=checkin when present. */
  checkinDayKey: z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}$/)
    .optional(),
  /** When true, include the viewer's own posts in results (overrides home-feed self-exclusion). */
  includeSelf: queryBoolean().optional(),
  // Optional author filter (comma-separated user IDs). Used by Explore to show trending by recommended users.
  authorIds: z.string().optional(),
  // "trending" is the UI-friendly name for our half-life boost scoring feed.
  // Keep "popular" for backwards compatibility / internal naming.
  // "forYou" is a personalized re-rank of trending using the viewer's follow graph + view history.
  sort: z.enum(["new", "popular", "trending", "featured", "forYou"]).optional(),
  /** Cursor-less For You pull-to-refresh: skip the 15s page-1 cache and apply refresh jitter. */
  refresh: queryBoolean().optional(),
  collapseByRoot: queryBoolean().optional(),
  collapseMode: z.enum(["root", "parent"]).optional(),
  prefer: z.enum(["reply", "root"]).optional(),
  collapseMaxPerRoot: z.coerce.number().int().min(1).max(5).optional(),
  /** All groups the viewer is in (members-only). Mutually exclusive with `communityGroupId` in practice. */
  groupsHub: queryBoolean().optional(),
  /** Single community group feed (members-only). */
  communityGroupId: z.string().trim().min(1).max(40).optional(),
  /** When true, return only top-level (non-reply) posts. */
  topLevelOnly: queryBoolean().optional(),
  /** Filter to posts whose author has a matching location state (2-letter US state code, e.g. "VA"). */
  authorLocationState: z.string().trim().min(2).max(2).optional(),
});

@Injectable()
export class PostsListQueryService {
  private readonly logger = new Logger(PostsListQueryService.name);

  constructor(
    @Inject(PostsFeedListingsService) private readonly postsListings: Pick<PostsFeedListingsService, 'assertCanReadCommunityGroup' | 'listActiveCommunityGroupIdsForUser' | 'listComposedGroupScopedFeed' | 'listFeed'>,
    @Inject(PostsFeedForYouService) private readonly postsForYou: Pick<PostsFeedForYouService, 'listForYouFeed'>,
    @Inject(PostsFeedFeaturedService) private readonly postsFeatured: Pick<PostsFeedFeaturedService, 'listFeaturedFeed'>,
    @Inject(PostsFeedPopularService) private readonly postsPopular: Pick<PostsFeedPopularService, 'listPopularFeed'>,
    @Inject(PostsFeedComposeService) private readonly postsCompose: Pick<PostsFeedComposeService, 'composeFeedPostDtos'>,
    private readonly appConfig: AppConfigService,
    private readonly cache: CacheService,
    private readonly cacheInvalidation: CacheInvalidationService,
  ) {}

  async listPosts(
    userId: string | undefined,
    query: unknown,
    httpRes: Response,
  ) {
    const reqStartMs = Date.now();
    const stageMs: Record<string, number> = {};
    const parsed = listSchema.parse(query);
    const viewerUserId = userId ?? null;
    const limit = parsed.limit ?? 30;
    const cursor = parsed.cursor ?? null;
    const authorUserIds =
      (parsed.authorIds ?? "")
        .split(",")
        .map((s) => s.trim())
        .filter(Boolean)
        .slice(0, 50) || [];

    // When checkinDayKey is provided, the request is scoped to a specific check-in day;
    // force kind=checkin and disable the shared feed cache (day-scoped feeds are small/specific).
    const checkinDayKey = parsed.checkinDayKey ?? null;
    const effectiveKind: "regular" | "checkin" | null = checkinDayKey
      ? "checkin"
      : (parsed.kind ?? null);
    // Check-in feeds always include the viewer's own posts — no need for callers to opt in.
    const includeSelf =
      effectiveKind === "checkin" ? true : (parsed.includeSelf ?? false);

    const sort = parsed.sort ?? "new";
    const requestedSortKind = sort === "trending" ? "popular" : sort;
    // For You works for anonymous viewers too — listForYouFeed handles null viewerUserId
    // by restricting to public posts and skipping all personalized lanes (no last-seen,
    // no follows, no blocks). The result is a public discovery blend with For You scoring.
    const sortKind = requestedSortKind;
    const isForYou = sortKind === "forYou";
    const groupScoped = Boolean(parsed.groupsHub || parsed.communityGroupId);
    // Media grids should be exhaustive for Newest, while Trending/For You still
    // need distinct ordering. The media trending path includes zero-score media
    // so it does not go empty just because older posts are no longer hot.
    const mediaOnly = parsed.mediaOnly ?? false;
    const mediaChronological =
      mediaOnly &&
      !groupScoped &&
      sortKind !== "forYou" &&
      sortKind !== "popular";

    if (groupScoped) {
      if (!viewerUserId)
        throw new ForbiddenException("Sign in to view this feed.");
      const groupSort =
        sortKind === "popular" || sort === "trending" ? "trending" : "new";
      let groupIds: string[];
      let applyPinnedHead: boolean;
      if (parsed.communityGroupId) {
        const gid = parsed.communityGroupId.trim();
        await this.postsListings.assertCanReadCommunityGroup(viewerUserId, gid);
        groupIds = [gid];
        applyPinnedHead = groupSort === "new";
      } else {
        groupIds =
          await this.postsListings.listActiveCommunityGroupIdsForUser(viewerUserId);
        applyPinnedHead = false;
      }
      const scopedOut =
        groupIds.length === 0
          ? { data: [], pagination: { nextCursor: null } }
          : await this.postsListings.listComposedGroupScopedFeed({
              viewerUserId,
              groupIds,
              limit,
              cursor,
              sort: groupSort,
              applyPinnedHead,
              collapseByRoot: parsed.collapseByRoot ?? true,
              collapseMode: parsed.collapseMode ?? "root",
              prefer: parsed.prefer ?? "reply",
              collapseMaxPerRoot: parsed.collapseMaxPerRoot ?? 2,
              topLevelOnly: parsed.topLevelOnly,
            });
      const totalMsGroup = Date.now() - reqStartMs;
      httpRes.setHeader("x-feed-total-ms", String(totalMsGroup));
      setReadCache(httpRes, { viewerUserId });
      return scopedOut;
    }

    // Anon For You applies a per-request score jitter so each refresh shows a different order —
    // caching would freeze that order, so we skip the cache for anon For You.
    // Authed For You page 1 is cached as a composed payload (15s) with a stampede lock.
    // lastSeenAt refreshes bump a per-user For You version so the next refresh re-ranks.
    const anonCache = viewerUserId == null && !isForYou;
    const wantsForYouRefresh = isForYou && Boolean(parsed.refresh) && !cursor;
    const authForYouFirstPageCache =
      isForYou &&
      Boolean(viewerUserId) &&
      !cursor &&
      !wantsForYouRefresh &&
      !authorUserIds.length &&
      !effectiveKind &&
      !checkinDayKey &&
      !(parsed.mediaOnly ?? false) &&
      !(parsed.followingOnly ?? false);
    const authFirstPageCache = !isForYou && Boolean(viewerUserId) && !cursor;
    const authCursorCache =
      !isForYou &&
      Boolean(viewerUserId) &&
      Boolean(cursor) &&
      (sortKind === "new" ||
        sortKind === "popular" ||
        sortKind === "featured") &&
      !authorUserIds.length &&
      !effectiveKind &&
      !checkinDayKey &&
      !(parsed.mediaOnly ?? false) &&
      !(parsed.followingOnly ?? false) &&
      String(cursor).trim().length <= 64;
    const feedVer =
      anonCache ||
      authFirstPageCache ||
      authCursorCache ||
      authForYouFirstPageCache
        ? await this.cacheInvalidation.feedGlobalVersion()
        : null;
    const forYouUserVer =
      authForYouFirstPageCache && viewerUserId
        ? await this.cacheInvalidation.forYouUserVersion(viewerUserId)
        : null;
    const cacheEnabled =
      Boolean(feedVer) &&
      (anonCache ||
        authFirstPageCache ||
        authCursorCache ||
        authForYouFirstPageCache);
    const paramsHash = cacheEnabled
      ? stableJsonHash({
          endpoint: "posts:list",
          sort: sortKind,
          limit,
          cursor,
          visibility: parsed.visibility ?? "all",
          followingOnly: parsed.followingOnly ?? false,
          kind: effectiveKind,
          checkinDayKey,
          includeSelf,
          mediaOnly: parsed.mediaOnly ?? false,
          forYouUserVer,
          topLevelOnly: parsed.topLevelOnly ?? false,
          authorUserIds,
          collapseByRoot: parsed.collapseByRoot ?? false,
          collapseMode: parsed.collapseMode ?? "root",
          collapsePrefer: parsed.prefer ?? "reply",
          collapseMaxPerRoot: parsed.collapseMaxPerRoot ?? 1,
        })
      : null;
    const cacheKey =
      cacheEnabled && feedVer && paramsHash
        ? anonCache
          ? RedisKeys.anonPostsList(paramsHash, feedVer)
          : RedisKeys.authPostsList(viewerUserId!, paramsHash, feedVer)
        : null;
    const cacheLockKey =
      cacheEnabled && feedVer && paramsHash
        ? anonCache
          ? RedisKeys.anonPostsListLock(paramsHash, feedVer)
          : RedisKeys.authPostsListLock(viewerUserId!, paramsHash, feedVer)
        : "";
    const cacheTtlSeconds = anonCache
      ? CacheTtl.anonFeedSeconds
      : authForYouFirstPageCache
        ? CacheTtl.forYouRankedPage1Seconds
        : authFirstPageCache
          ? CacheTtl.authFeedSeconds
          : CacheTtl.authCursorFeedSeconds;

    const computeFeed = async () => {
      const listStartMs = Date.now();
      const result =
        sortKind === "forYou" && !mediaChronological
          ? await this.postsForYou.listForYouFeed({
              viewerUserId,
              limit,
              cursor,
              visibility: parsed.visibility ?? "all",
              kind: effectiveKind,
              checkinDayKey,
              includeSelf,
              mediaOnly,
              topLevelOnly: parsed.topLevelOnly ?? false,
              authorUserIds: authorUserIds.length ? authorUserIds : null,
              authorLocationState: parsed.authorLocationState ?? null,
              refresh: wantsForYouRefresh,
            })
          : sortKind === "featured" && !mediaChronological
            ? await this.postsFeatured.listFeaturedFeed({
                viewerUserId,
                limit,
                cursor,
                visibility: parsed.visibility ?? "all",
                followingOnly: parsed.followingOnly ?? false,
                kind: effectiveKind,
                checkinDayKey,
                includeSelf,
                mediaOnly,
                topLevelOnly: parsed.topLevelOnly ?? false,
                authorUserIds: authorUserIds.length ? authorUserIds : null,
                authorLocationState: parsed.authorLocationState ?? null,
              })
            : sortKind === "popular" && !mediaChronological
              ? await this.postsPopular.listPopularFeed({
                  viewerUserId,
                  limit,
                  cursor,
                  visibility: parsed.visibility ?? "all",
                  followingOnly: parsed.followingOnly ?? false,
                  kind: effectiveKind,
                  checkinDayKey,
                  includeSelf,
                  mediaOnly,
                  topLevelOnly: parsed.topLevelOnly ?? false,
                  authorUserIds: authorUserIds.length ? authorUserIds : null,
                  authorLocationState: parsed.authorLocationState ?? null,
                })
              : await this.postsListings.listFeed({
                  viewerUserId,
                  limit,
                  cursor,
                  visibility: parsed.visibility ?? "all",
                  followingOnly: parsed.followingOnly ?? false,
                  kind: effectiveKind,
                  checkinDayKey,
                  includeSelf,
                  mediaOnly,
                  topLevelOnly: parsed.topLevelOnly ?? false,
                  authorUserIds: authorUserIds.length ? authorUserIds : null,
                  authorLocationState: parsed.authorLocationState ?? null,
                });
      stageMs.list = Date.now() - listStartMs;

      const dedupeStartMs = Date.now();
      const feedAuthorBaseUrl = this.appConfig.r2()?.publicBaseUrl ?? null;
      // Collapse multiple flat-repost rows for the same original into one surviving row
      // and remove co-page standalone originals (the repost shell already embeds them).
      // repostedByAuthorsByItemId / repostedByCountByItemId are attached to DTOs for
      // "Alice and N others reposted" UI.
      const {
        items: dedupedPosts,
        repostedByAuthorsByItemId,
        repostedByCountByItemId,
      } = collapseRepostsByCanonical(result.posts, (p) =>
        toPostAuthorDtoFromFeedRow(p, feedAuthorBaseUrl),
      );

      const { items: filteredPosts, collapsedItemsByItemId } =
        collapseFeedByRoot(dedupedPosts, {
          collapseByRoot: parsed.collapseByRoot ?? false,
          collapseMode: parsed.collapseMode ?? "root",
          prefer: parsed.prefer ?? "reply",
          maxPerRoot: parsed.collapseMaxPerRoot ?? 1,
          getId: (post) => post.id,
          getParentId: (post) => post.parentId ?? null,
          getAuthorPreview: (post) =>
            toPostAuthorDtoFromFeedRow(post, feedAuthorBaseUrl),
        });
      stageMs.dedupe = Date.now() - dedupeStartMs;
      const dtoStartMs = Date.now();
      const popResult = result as { scoreByPostId?: Map<string, number> };
      const dtos = await this.postsCompose.composeFeedPostDtos({
        viewerUserId,
        filteredPosts,
        collapsedItemsByItemId,
        scoreByPostId: popResult.scoreByPostId,
        conversationContext: sortKind === "forYou",
      });
      // Annotate collapsed repost rows so the UI can render "Alice and N others reposted".
      for (const dto of dtos) {
        const authors = repostedByAuthorsByItemId.get(dto.id);
        const count = repostedByCountByItemId.get(dto.id);
        if (authors) dto.repostedByAuthors = authors;
        if (count) dto.repostedByCount = count;
      }
      const payload = {
        data: dtos,
        pagination: { nextCursor: result.nextCursor },
      };
      stageMs.dto = Date.now() - dtoStartMs;
      return payload;
    };

    const out =
      cacheEnabled && cacheKey && cacheLockKey
        ? await this.cache.getOrSetJsonWithLock<{ data: any; pagination: any }>(
            {
              enabled: true,
              key: cacheKey,
              ttlSeconds: cacheTtlSeconds,
              lockKey: cacheLockKey,
              lockTtlMs: 10_000,
              lockWaitMs: 750,
              computeAndSet: computeFeed,
              fallback: computeFeed,
              waitForResult: true,
            },
          )
        : await computeFeed();

    const totalMs = Date.now() - reqStartMs;
    httpRes.setHeader("x-feed-total-ms", String(totalMs));
    if (Object.keys(stageMs).length > 0) {
      const serverTiming = Object.entries(stageMs)
        .filter(([, ms]) => Number.isFinite(ms))
        .map(([name, ms]) => `${name};dur=${Math.max(0, Math.round(ms))}`)
        .join(", ");
      if (serverTiming) httpRes.setHeader("server-timing", serverTiming);
    }
    const feedCacheMode = anonCache
      ? "anon"
      : authForYouFirstPageCache
        ? "auth_foryou"
        : authFirstPageCache
          ? "auth_first_page"
          : authCursorCache
            ? "auth_cursor"
            : "none";
    httpRes.setHeader("x-feed-cache-mode", feedCacheMode);
    if (totalMs >= 800) {
      this.logger.warn(
        `GET /posts slow request: ${totalMs}ms (sort=${sortKind}, cursor=${cursor ? "yes" : "no"}, mode=${feedCacheMode})`,
      );
    }
    setReadCache(httpRes, { viewerUserId });
    return out;
  }
}
