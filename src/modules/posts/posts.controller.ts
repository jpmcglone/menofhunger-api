import { Body, Controller, Delete, ForbiddenException, Get, Headers, Logger, Param, Patch, Post, Query, Res, UseGuards } from '@nestjs/common';
import { z } from 'zod';
import { ApiTags } from '@nestjs/swagger';
import { Throttle } from '@nestjs/throttler';
import type { Response } from 'express';
import { AuthGuard } from '../auth/auth.guard';
import { OptionalAuthGuard } from '../auth/optional-auth.guard';
import { AppConfigService } from '../app/app-config.service';
import { CurrentUserId, OptionalCurrentUserId } from '../users/users.decorator';
import { PostsService } from './posts.service';
import { toPostDto, toPostPollDto, toPostAuthorDtoFromFeedRow } from './post.dto';
import { buildAttachParentChain } from './posts.utils';
import { rateLimitLimit, rateLimitTtl } from '../../common/throttling/rate-limit.resolver';
import { setReadCache } from '../../common/http-cache';
import { CacheInvalidationService } from '../redis/cache-invalidation.service';
import { RedisKeys, stableJsonHash } from '../redis/redis-keys';
import { CacheService } from '../redis/cache.service';
import { CacheTtl } from '../redis/cache-ttl';
import { collapseFeedByRoot } from '../../common/feed-collapse/collapse-by-root';
import { collapseRepostsByCanonical } from '../../common/feed-collapse/collapse-reposts-by-canonical';
import type { CommunityGroupPreviewDto } from '../../common/dto/community-group.dto';
import { queryBoolean } from '../../common/validation/query-boolean';

const readThrottle = {
  default: {
    limit: rateLimitLimit('read', 120),
    ttl: rateLimitTtl('read', 60),
  },
};

/**
 * Parse the optional `x-marv-mode` request header into the `MarvinMode` enum.
 * Returns null when the header is missing/invalid — the public-reply processor will
 * fall back to the user's stored preferred mode in that case.
 */
function parseMarvModeHeader(raw: string | undefined): 'fast' | 'regular' | 'smart' | null {
  const v = (raw ?? '').trim().toLowerCase();
  if (v === 'fast' || v === 'regular' || v === 'smart') return v;
  return null;
}

const listSchema = z.object({
  limit: z.coerce.number().int().min(1).max(50).optional(),
  cursor: z.string().optional(),
  visibility: z.enum(['all', 'public', 'verifiedOnly', 'premiumOnly']).optional(),
  followingOnly: queryBoolean().optional(),
  mediaOnly: queryBoolean().optional(),
  kind: z.enum(['regular', 'checkin']).optional(),
  /** Filter check-ins to a specific ET day (YYYY-MM-DD). Forces kind=checkin when present. */
  checkinDayKey: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
  /** When true, include the viewer's own posts in results (overrides home-feed self-exclusion). */
  includeSelf: queryBoolean().optional(),
  // Optional author filter (comma-separated user IDs). Used by Explore to show trending by recommended users.
  authorIds: z.string().optional(),
  // "trending" is the UI-friendly name for our half-life boost scoring feed.
  // Keep "popular" for backwards compatibility / internal naming.
  // "forYou" is a personalized re-rank of trending using the viewer's follow graph + view history.
  sort: z.enum(['new', 'popular', 'trending', 'featured', 'forYou']).optional(),
  /** Cursor-less For You pull-to-refresh: skip the 15s page-1 cache and apply refresh jitter. */
  refresh: queryBoolean().optional(),
  collapseByRoot: queryBoolean().optional(),
  collapseMode: z.enum(['root', 'parent']).optional(),
  prefer: z.enum(['reply', 'root']).optional(),
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

const userListSchema = listSchema.extend({
  visibility: z.enum(['all', 'public', 'verifiedOnly', 'premiumOnly']).optional(),
  includeCounts: queryBoolean().optional(),
  topLevelOnly: queryBoolean().optional(),
  includeRestricted: queryBoolean().optional(),
});

const userMediaListSchema = z.object({
  limit: z.coerce.number().int().min(1).max(50).optional(),
  cursor: z.string().optional(),
  visibility: z.enum(['all', 'public', 'verifiedOnly', 'premiumOnly']).optional(),
  sort: z.enum(['new', 'trending']).optional(),
  includeRestricted: queryBoolean().optional(),
});

const createUploadMediaItemSchema = z.object({
  source: z.literal('upload'),
  kind: z.enum(['image', 'gif', 'video']),
  r2Key: z.string().min(1),
  thumbnailR2Key: z.string().min(1).optional(),
  width: z.coerce.number().int().min(1).max(20000).optional(),
  height: z.coerce.number().int().min(1).max(20000).optional(),
  durationSeconds: z.coerce.number().int().min(0).max(3600).optional(),
  alt: z.string().trim().max(500).nullish(),
});

const createPollOptionImageSchema = z.object({
  source: z.literal('upload'),
  kind: z.literal('image'),
  r2Key: z.string().min(1),
  width: z.coerce.number().int().min(1).max(20000).optional(),
  height: z.coerce.number().int().min(1).max(20000).optional(),
  alt: z.string().trim().max(500).nullish(),
});

const createMediaItemSchema = z.discriminatedUnion('source', [
  createUploadMediaItemSchema,
  z.object({
    source: z.literal('giphy'),
    kind: z.literal('gif'),
    url: z.string().url(),
    mp4Url: z.string().url().optional(),
    width: z.coerce.number().int().min(1).max(20000).optional(),
    height: z.coerce.number().int().min(1).max(20000).optional(),
    alt: z.string().trim().max(500).nullish(),
  }),
]);

type CreateMediaItem = z.infer<typeof createMediaItemSchema>;

const createPollSchema = z.object({
  options: z
    .array(
      z.object({
        text: z.string().trim().max(30).optional(),
        image: createPollOptionImageSchema.nullish(),
      }),
    )
    .min(2)
    .max(5),
  duration: z.object({
    days: z.coerce.number().int().min(0).max(7),
    hours: z.coerce.number().int().min(0).max(23),
    minutes: z.coerce.number().int().min(0).max(59),
  }),
}).superRefine((val, ctx) => {
  const opts = val.options ?? [];
  for (let i = 0; i < opts.length; i++) {
    const o = opts[i]!;
    const text = (o.text ?? '').trim();
    const hasText = Boolean(text);
    const hasImage = Boolean(o.image?.r2Key);
    if (!hasText && !hasImage) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'Poll option must include text or an image.',
        path: ['options', i, 'text'],
      });
    }
  }

  // Product rule: if any option includes an image, all options must include an image.
  const anyHasImage = opts.some((o) => Boolean(o?.image?.r2Key));
  if (anyHasImage) {
    for (let i = 0; i < opts.length; i++) {
      const o = opts[i]!;
      if (!o?.image?.r2Key) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: 'If any poll option has an image, all poll options must have images.',
          path: ['options', i, 'image'],
        });
      }
    }
  }
});

const createSchema = z
  .object({
    body: z.string().trim().max(1000).optional(),
    visibility: z.enum(['public', 'verifiedOnly', 'premiumOnly', 'onlyMe']).optional(),
    parent_id: z.string().cuid().optional(),
    /** Top-level posts only: post into this community group (must be an active member). */
    community_group_id: z.string().cuid().optional(),
    mentions: z.array(z.string().min(1).max(120)).max(20).optional(),
    media: z.array(createMediaItemSchema).max(4).optional(),
    poll: createPollSchema.optional(),
  })
  .superRefine((val, ctx) => {
    const body = (val.body ?? '').trim();
    const mediaCount = val.media?.length ?? 0;
    const hasPoll = Boolean(val.poll);
    if (!body && mediaCount === 0 && !hasPoll) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'Post must include text, media, or a poll.',
        path: ['body'],
      });
    }
    if (hasPoll && mediaCount > 0) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'You cannot attach media to a poll post.',
        path: ['media'],
      });
    }
    if (hasPoll && val.parent_id) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'Polls are not allowed on replies.',
        path: ['poll'],
      });
    }
    if (hasPoll) {
      const d = val.poll?.duration;
      const days = typeof d?.days === 'number' ? d.days : 0;
      const hours = typeof d?.hours === 'number' ? d.hours : 0;
      const minutes = typeof d?.minutes === 'number' ? d.minutes : 0;
      const totalSeconds = days * 24 * 60 * 60 + hours * 60 * 60 + minutes * 60;
      if (totalSeconds <= 0) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: 'Poll duration must be at least 1 minute.',
          path: ['poll', 'duration'],
        });
      }
      if (totalSeconds > 7 * 24 * 60 * 60) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: 'Poll duration must be 7 days or shorter.',
          path: ['poll', 'duration'],
        });
      }
      if (days === 7 && (hours > 0 || minutes > 0)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: 'When days is 7, hours and minutes must be 0.',
          path: ['poll', 'duration'],
        });
      }
    }
    // Video uploads: require dimensions and duration; MB + duration limits enforced server-side.
    for (let i = 0; i < (val.media ?? []).length; i++) {
      const item = val.media![i];
      if (item.source !== 'upload' || item.kind !== 'video') continue;
      const width = typeof item.width === 'number' ? item.width : null;
      const height = typeof item.height === 'number' ? item.height : null;
      const durationSeconds = typeof item.durationSeconds === 'number' ? item.durationSeconds : null;
      if (width == null || height == null || durationSeconds == null) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: 'Video media must include width, height, and durationSeconds.',
          path: ['media', i, 'width'],
        });
        continue;
      }
      if (durationSeconds > 5 * 60) {
        ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'Video must be 5 minutes or shorter.', path: ['media', i, 'durationSeconds'] });
      }
    }
  });

const updateSchema = z
  .object({
    body: z.string().trim().max(1000).optional(),
  })
  .superRefine((val, ctx) => {
    const body = (val.body ?? '').trim();
    if (!body) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'Post must include text.',
        path: ['body'],
      });
    }
  });

const publishFromOnlyMeSchema = z.object({
  body: z.string().trim().max(1000).optional(),
  visibility: z.enum(['public', 'verifiedOnly', 'premiumOnly']),
  media: z
    .array(
      z.discriminatedUnion('source', [
        z.object({
          source: z.literal('existing'),
          id: z.string().min(1),
          alt: z.string().trim().max(500).nullish(),
        }),
        createUploadMediaItemSchema,
        z.object({
          source: z.literal('giphy'),
          kind: z.literal('gif'),
          url: z.string().url(),
          mp4Url: z.string().url().optional(),
          width: z.coerce.number().int().min(1).max(20000).optional(),
          height: z.coerce.number().int().min(1).max(20000).optional(),
          alt: z.string().trim().max(500).nullish(),
        }),
      ]),
    )
    .max(4)
    .optional(),
});

@ApiTags('Feed & Posts')
@Controller('posts')
export class PostsController {
  private readonly logger = new Logger(PostsController.name);

  constructor(
    private readonly posts: PostsService,
    private readonly appConfig: AppConfigService,
    private readonly cache: CacheService,
    private readonly cacheInvalidation: CacheInvalidationService,
  ) {}

  private async communityGroupPreviewMapForIds(
    viewerUserId: string | null,
    groupIds: string[],
  ): Promise<Map<string, CommunityGroupPreviewDto>> {
    return this.posts.communityGroupPreviewMapForFeed(viewerUserId, groupIds);
  }

  /**
   * Permalink hydration used to walk parentId with sequential getById calls
   * (one heavy include per ancestor). Feed compose already batches this via
   * collectAncestorPostIds + getByIds — keep that here so /p/:id stays O(1)
   * round trips instead of O(depth).
   */
  private async loadPermalinkRelatedPosts(params: {
    viewerUserId: string | null;
    viewerHasAdmin: boolean;
    leaf: Awaited<ReturnType<PostsService['getById']>>;
    leafGated: boolean;
  }): Promise<{
    chain: Array<Awaited<ReturnType<PostsService['getById']>>>;
    gatedChainIndices: Set<number>;
    byId: Map<string, Awaited<ReturnType<PostsService['getById']>>>;
    repostedPostRaw: Awaited<ReturnType<PostsService['getById']>> | null;
  }> {
    const { viewerUserId, viewerHasAdmin, leaf, leafGated } = params;
    const leafParentId = (leaf as { parentId?: string | null }).parentId ?? null;
    const leafRepostedId = (leaf as { repostedPostId?: string | null }).repostedPostId ?? null;

    const ancestorIds = await this.posts.collectAncestorPostIds([leafParentId, leafRepostedId]);
    const fetched = ancestorIds.length
      ? await this.posts.getByIds({ viewerUserId, ids: ancestorIds })
      : [];

    const byId = new Map<string, Awaited<ReturnType<PostsService['getById']>>>();
    for (const row of fetched) {
      const deletedAt = (row as { deletedAt?: Date | null }).deletedAt ?? null;
      if (deletedAt && !viewerHasAdmin) continue;
      byId.set(row.id, row);
    }

    const missingIds = ancestorIds.filter((id) => !byId.has(id));
    const gatedIds = new Set<string>();
    if (missingIds.length > 0) {
      const gatedRows = await Promise.all(
        missingIds.map((id) => this.posts.getByIdNoAccess(id).catch(() => null)),
      );
      for (const row of gatedRows) {
        if (!row) continue;
        byId.set(row.id, row);
        gatedIds.add(row.id);
      }
    }

    const chain: Array<Awaited<ReturnType<PostsService['getById']>>> = [leaf];
    const gatedChainIndices = new Set<number>();
    if (leafGated) gatedChainIndices.add(0);

    let current = leaf;
    while (current) {
      const parentId = (current as { parentId?: string | null }).parentId ?? null;
      if (!parentId) break;
      const next = byId.get(parentId);
      if (!next) break;
      chain.push(next);
      if (gatedIds.has(next.id)) {
        gatedChainIndices.add(chain.length - 1);
        break;
      }
      current = next;
    }

    const quotedSeeds = [
      ...chain,
      ...(leafRepostedId && byId.has(leafRepostedId) ? [byId.get(leafRepostedId)!] : []),
    ];
    const quotedPostIds = [
      ...new Set(
        quotedSeeds
          .map((p) => (p as { quotedPostId?: string | null }).quotedPostId)
          .filter((id): id is string => Boolean(id)),
      ),
    ].filter((id) => !byId.has(id));
    if (quotedPostIds.length > 0) {
      const quoted = await this.posts.getByIds({ viewerUserId, ids: quotedPostIds });
      for (const row of quoted) byId.set(row.id, row);
      const stillMissing = quotedPostIds.filter((id) => !byId.has(id));
      if (stillMissing.length > 0) {
        const gatedQuoted = await Promise.all(
          stillMissing.map((id) => this.posts.getByIdNoAccess(id).catch(() => null)),
        );
        for (const row of gatedQuoted) {
          if (row) byId.set(row.id, row);
        }
      }
    }

    return {
      chain,
      gatedChainIndices,
      byId,
      repostedPostRaw: leafRepostedId ? byId.get(leafRepostedId) ?? null : null,
    };
  }

  @UseGuards(OptionalAuthGuard)
  @Throttle({
    default: {
      limit: rateLimitLimit('publicRead', 240),
      ttl: rateLimitTtl('publicRead', 60),
    },
  })
  @Get()
  async list(
    @OptionalCurrentUserId() userId: string | undefined,
    @Query() query: unknown,
    @Res({ passthrough: true }) httpRes: Response,
  ) {
    const reqStartMs = Date.now();
    const stageMs: Record<string, number> = {};
    const parsed = listSchema.parse(query);
    const viewerUserId = userId ?? null;
    const limit = parsed.limit ?? 30;
    const cursor = parsed.cursor ?? null;
    const authorUserIds =
      (parsed.authorIds ?? '')
        .split(',')
        .map((s) => s.trim())
        .filter(Boolean)
        .slice(0, 50) || [];

    // When checkinDayKey is provided, the request is scoped to a specific check-in day;
    // force kind=checkin and disable the shared feed cache (day-scoped feeds are small/specific).
    const checkinDayKey = parsed.checkinDayKey ?? null;
    const effectiveKind: 'regular' | 'checkin' | null = checkinDayKey ? 'checkin' : (parsed.kind ?? null);
    // Check-in feeds always include the viewer's own posts — no need for callers to opt in.
    const includeSelf = effectiveKind === 'checkin' ? true : (parsed.includeSelf ?? false);

    const sort = parsed.sort ?? 'new';
    const requestedSortKind = sort === 'trending' ? 'popular' : sort;
    // For You works for anonymous viewers too — listForYouFeed handles null viewerUserId
    // by restricting to public posts and skipping all personalized lanes (no last-seen,
    // no follows, no blocks). The result is a public discovery blend with For You scoring.
    const sortKind = requestedSortKind;
    const isForYou = sortKind === 'forYou';
    const groupScoped = Boolean(parsed.groupsHub || parsed.communityGroupId);
    // Media grids should be exhaustive for Newest, while Trending/For You still
    // need distinct ordering. The media trending path includes zero-score media
    // so it does not go empty just because older posts are no longer hot.
    const mediaOnly = parsed.mediaOnly ?? false;
    const mediaChronological = mediaOnly && !groupScoped && sortKind !== 'forYou' && sortKind !== 'popular';

    if (groupScoped) {
      if (!viewerUserId) throw new ForbiddenException('Sign in to view this feed.');
      const groupSort = sortKind === 'popular' || sort === 'trending' ? 'trending' : 'new';
      let groupIds: string[];
      let applyPinnedHead: boolean;
      if (parsed.communityGroupId) {
        const gid = parsed.communityGroupId.trim();
        await this.posts.assertCanReadCommunityGroup(viewerUserId, gid);
        groupIds = [gid];
        applyPinnedHead = groupSort === 'new';
      } else {
        groupIds = await this.posts.listActiveCommunityGroupIdsForUser(viewerUserId);
        applyPinnedHead = false;
      }
      const scopedOut =
        groupIds.length === 0
          ? { data: [], pagination: { nextCursor: null } }
          : await this.posts.listComposedGroupScopedFeed({
              viewerUserId,
              groupIds,
              limit,
              cursor,
              sort: groupSort,
              applyPinnedHead,
              collapseByRoot: parsed.collapseByRoot ?? true,
              collapseMode: parsed.collapseMode ?? 'root',
              prefer: parsed.prefer ?? 'reply',
              collapseMaxPerRoot: parsed.collapseMaxPerRoot ?? 2,
              topLevelOnly: parsed.topLevelOnly,
            });
      const totalMsGroup = Date.now() - reqStartMs;
      httpRes.setHeader('x-feed-total-ms', String(totalMsGroup));
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
      isForYou
      && Boolean(viewerUserId)
      && !cursor
      && !wantsForYouRefresh
      && !authorUserIds.length
      && !effectiveKind
      && !checkinDayKey
      && !(parsed.mediaOnly ?? false)
      && !(parsed.followingOnly ?? false);
    const authFirstPageCache = !isForYou && Boolean(viewerUserId) && !cursor;
    const authCursorCache = !isForYou
      && Boolean(viewerUserId)
      && Boolean(cursor)
      && (sortKind === 'new' || sortKind === 'popular' || sortKind === 'featured')
      && !authorUserIds.length
      && !effectiveKind
      && !checkinDayKey
      && !(parsed.mediaOnly ?? false)
      && !(parsed.followingOnly ?? false)
      && String(cursor).trim().length <= 64;
    const feedVer = (anonCache || authFirstPageCache || authCursorCache || authForYouFirstPageCache)
      ? await this.cacheInvalidation.feedGlobalVersion()
      : null;
    const forYouUserVer = authForYouFirstPageCache && viewerUserId
      ? await this.cacheInvalidation.forYouUserVersion(viewerUserId)
      : null;
    const cacheEnabled = Boolean(feedVer) && (anonCache || authFirstPageCache || authCursorCache || authForYouFirstPageCache);
    const paramsHash = cacheEnabled
      ? stableJsonHash({
          endpoint: 'posts:list',
          sort: sortKind,
          limit,
          cursor,
          visibility: parsed.visibility ?? 'all',
          followingOnly: parsed.followingOnly ?? false,
          kind: effectiveKind,
          checkinDayKey,
          includeSelf,
          mediaOnly: parsed.mediaOnly ?? false,
          forYouUserVer,
          topLevelOnly: parsed.topLevelOnly ?? false,
          authorUserIds,
          collapseByRoot: parsed.collapseByRoot ?? false,
          collapseMode: parsed.collapseMode ?? 'root',
          collapsePrefer: parsed.prefer ?? 'reply',
          collapseMaxPerRoot: parsed.collapseMaxPerRoot ?? 1,
        })
      : null;
    const cacheKey =
      cacheEnabled && feedVer && paramsHash
        ? (anonCache
            ? RedisKeys.anonPostsList(paramsHash, feedVer)
            : RedisKeys.authPostsList(viewerUserId!, paramsHash, feedVer))
        : null;
    const cacheLockKey =
      cacheEnabled && feedVer && paramsHash
        ? (anonCache
            ? RedisKeys.anonPostsListLock(paramsHash, feedVer)
            : RedisKeys.authPostsListLock(viewerUserId!, paramsHash, feedVer))
        : '';
    const cacheTtlSeconds = anonCache
      ? CacheTtl.anonFeedSeconds
      : (authForYouFirstPageCache
          ? CacheTtl.forYouRankedPage1Seconds
          : (authFirstPageCache ? CacheTtl.authFeedSeconds : CacheTtl.authCursorFeedSeconds));

    const computeFeed = async () => {
        const listStartMs = Date.now();
        const result =
          sortKind === 'forYou' && !mediaChronological
            ? await this.posts.listForYouFeed({
                viewerUserId,
                limit,
                cursor,
                visibility: parsed.visibility ?? 'all',
                kind: effectiveKind,
                checkinDayKey,
                includeSelf,
                mediaOnly,
                topLevelOnly: parsed.topLevelOnly ?? false,
                authorUserIds: authorUserIds.length ? authorUserIds : null,
                authorLocationState: parsed.authorLocationState ?? null,
                refresh: wantsForYouRefresh,
              })
            : sortKind === 'featured' && !mediaChronological
              ? await this.posts.listFeaturedFeed({
                  viewerUserId,
                  limit,
                  cursor,
                  visibility: parsed.visibility ?? 'all',
                  followingOnly: parsed.followingOnly ?? false,
                  kind: effectiveKind,
                  checkinDayKey,
                  includeSelf,
                  mediaOnly,
                  topLevelOnly: parsed.topLevelOnly ?? false,
                  authorUserIds: authorUserIds.length ? authorUserIds : null,
                  authorLocationState: parsed.authorLocationState ?? null,
                })
              : sortKind === 'popular' && !mediaChronological
                ? await this.posts.listPopularFeed({
                    viewerUserId,
                    limit,
                    cursor,
                    visibility: parsed.visibility ?? 'all',
                    followingOnly: parsed.followingOnly ?? false,
                    kind: effectiveKind,
                    checkinDayKey,
                    includeSelf,
                    mediaOnly,
                    topLevelOnly: parsed.topLevelOnly ?? false,
                    authorUserIds: authorUserIds.length ? authorUserIds : null,
                    authorLocationState: parsed.authorLocationState ?? null,
                  })
                : await this.posts.listFeed({
                    viewerUserId,
                    limit,
                    cursor,
                    visibility: parsed.visibility ?? 'all',
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
        } = collapseRepostsByCanonical(
          result.posts,
          (p) => toPostAuthorDtoFromFeedRow(p, feedAuthorBaseUrl),
        );

        const { items: filteredPosts, collapsedItemsByItemId } =
          collapseFeedByRoot(dedupedPosts, {
          collapseByRoot: parsed.collapseByRoot ?? false,
          collapseMode: parsed.collapseMode ?? 'root',
          prefer: parsed.prefer ?? 'reply',
          maxPerRoot: parsed.collapseMaxPerRoot ?? 1,
          getId: (post) => post.id,
          getParentId: (post) => post.parentId ?? null,
          getAuthorPreview: (post) => toPostAuthorDtoFromFeedRow(post, feedAuthorBaseUrl),
        });
        stageMs.dedupe = Date.now() - dedupeStartMs;
        const dtoStartMs = Date.now();
        const popResult = result as { scoreByPostId?: Map<string, number> };
        const dtos = await this.posts.composeFeedPostDtos({
          viewerUserId,
          filteredPosts,
          collapsedItemsByItemId,
          scoreByPostId: popResult.scoreByPostId,
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

    const out = cacheEnabled && cacheKey && cacheLockKey
      ? await this.cache.getOrSetJsonWithLock<{ data: any; pagination: any }>({
          enabled: true,
          key: cacheKey,
          ttlSeconds: cacheTtlSeconds,
          lockKey: cacheLockKey,
          lockTtlMs: 10_000,
          lockWaitMs: 750,
          computeAndSet: computeFeed,
          fallback: computeFeed,
        })
      : await computeFeed();

    const totalMs = Date.now() - reqStartMs;
    httpRes.setHeader('x-feed-total-ms', String(totalMs));
    if (Object.keys(stageMs).length > 0) {
      const serverTiming = Object.entries(stageMs)
        .filter(([, ms]) => Number.isFinite(ms))
        .map(([name, ms]) => `${name};dur=${Math.max(0, Math.round(ms))}`)
        .join(', ');
      if (serverTiming) httpRes.setHeader('server-timing', serverTiming);
    }
    const feedCacheMode = anonCache
      ? 'anon'
      : (authForYouFirstPageCache
          ? 'auth_foryou'
          : (authFirstPageCache ? 'auth_first_page' : (authCursorCache ? 'auth_cursor' : 'none')));
    httpRes.setHeader('x-feed-cache-mode', feedCacheMode);
    if (totalMs >= 800) {
      this.logger.warn(`GET /posts slow request: ${totalMs}ms (sort=${sortKind}, cursor=${cursor ? 'yes' : 'no'}, mode=${feedCacheMode})`);
    }
    setReadCache(httpRes, { viewerUserId });
    return out;
  }

  @UseGuards(OptionalAuthGuard)
  @Get('user/:username')
  async listForUser(
    @OptionalCurrentUserId() userId: string | undefined,
    @Param('username') username: string,
    @Query() query: unknown,
    @Res({ passthrough: true }) httpRes: Response,
  ) {
    const parsed = userListSchema.parse(query);
    const viewerUserId = userId ?? null;
    const limit = parsed.limit ?? 30;
    const cursor = parsed.cursor ?? null;
    const sort = parsed.sort ?? 'new';
    const sortKind = sort === 'trending' ? 'popular' : sort;

    const anonCache = viewerUserId == null;
    const feedVer = anonCache ? await this.cacheInvalidation.feedGlobalVersion() : null;
    const paramsHash = anonCache
      ? stableJsonHash({
          endpoint: 'posts:user',
          sort: sortKind,
          limit,
          cursor,
          visibility: parsed.visibility ?? 'all',
          includeCounts: parsed.includeCounts ?? true,
          topLevelOnly: parsed.topLevelOnly ?? false,
        })
      : null;
    const cacheKey = anonCache && feedVer ? RedisKeys.anonPostsUser(username, paramsHash!, feedVer) : null;

    const out = await this.cache.getOrSetJson<{ data: any; pagination: any }>({
      enabled: anonCache && Boolean(cacheKey),
      key: cacheKey ?? '',
      ttlSeconds: CacheTtl.anonFeedSeconds,
      compute: async () => {
        const result = await this.posts.listForUsername({
          viewerUserId,
          username,
          limit,
          cursor,
          visibility: parsed.visibility ?? 'all',
          includeCounts: parsed.includeCounts ?? true,
          sort: sortKind === 'popular' ? 'popular' : 'new',
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
        } = collapseRepostsByCanonical(
          result.posts,
          (p) => toPostAuthorDtoFromFeedRow(p, profileAuthorBaseUrl),
        );
        const {
          items: filteredPostsUser,
          collapsedItemsByItemId: collapsedItemsByItemIdUser,
        } = collapseFeedByRoot(profileDedupedPosts, {
          collapseByRoot: parsed.collapseByRoot ?? false,
          collapseMode: parsed.collapseMode ?? 'root',
          prefer: parsed.prefer ?? 'reply',
          maxPerRoot: parsed.collapseMaxPerRoot ?? 1,
          getId: (post) => post.id,
          getParentId: (post) => post.parentId ?? null,
          getAuthorPreview: (post) => toPostAuthorDtoFromFeedRow(post, profileAuthorBaseUrl),
        });
        const dtos = await this.posts.composeFeedPostDtos({
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
          pagination: { nextCursor: result.nextCursor, counts: result.counts ?? null },
        };
      },
    });

    setReadCache(httpRes, { viewerUserId });
    return out;
  }

  // ─── User media grid ───────────────────────────────────────────────────────

  @UseGuards(OptionalAuthGuard)
  @Throttle(readThrottle)
  @Get('user/:username/media')
  async listUserMedia(
    @OptionalCurrentUserId() userId: string | undefined,
    @Param('username') username: string,
    @Query() query: unknown,
  ) {
    const parsed = userMediaListSchema.parse(query);
    const result = await this.posts.listMediaForUsername({
      viewerUserId: userId ?? null,
      username,
      limit: parsed.limit ?? 30,
      cursor: parsed.cursor ?? null,
      visibility: parsed.visibility ?? 'all',
      sort: parsed.sort ?? 'new',
      includeRestricted: parsed.includeRestricted ?? false,
    });
    return { data: result.items, pagination: { nextCursor: result.nextCursor } };
  }

  @UseGuards(AuthGuard)
  @Get('me/only-me')
  async listOnlyMe(@CurrentUserId() userId: string, @Query() query: unknown) {
    const parsed = z
      .object({
        limit: z.coerce.number().int().min(1).max(50).optional(),
        cursor: z.string().optional(),
      })
      .parse(query);

    const limit = parsed.limit ?? 30;
    const cursor = parsed.cursor ?? null;
    const res = await this.posts.listOnlyMe({ userId, limit, cursor });
    const viewer = await this.posts.viewerContext(userId);
    const viewerHasAdmin = Boolean(viewer?.siteAdmin);
    const internalByPostId = viewerHasAdmin ? await this.posts.ensureBoostScoresFresh(res.posts.map((p) => p.id)) : null;
    const scoreByPostIdOnlyMe =
      viewerHasAdmin ? await this.posts.computeScoresForPostIds(res.posts.map((p) => p.id)) : undefined;
    return {
      data: res.posts.map((p) => {
        const pWithPoll = p as { user?: { id?: string }; poll?: { creatorSkippedAt?: Date | null } };
        const viewerCreatorSkipped =
          pWithPoll.user?.id === userId && Boolean(pWithPoll.poll?.creatorSkippedAt);
        return toPostDto(p, this.appConfig.r2()?.publicBaseUrl ?? null, {
          viewerHasBoosted: false,
          viewerCreatorSkipped: viewerCreatorSkipped || undefined,
          includeInternal: viewerHasAdmin,
          internalOverride: (() => {
            const base = internalByPostId?.get(p.id);
            const score = scoreByPostIdOnlyMe?.get(p.id);
            return base || (typeof score === 'number' ? { score } : undefined)
              ? { ...base, ...(typeof score === 'number' ? { score } : {}) }
              : undefined;
          })(),
        });
      }),
      pagination: { nextCursor: res.nextCursor },
    };
  }

  @UseGuards(OptionalAuthGuard)
  @Throttle({
    default: {
      limit: rateLimitLimit('publicRead', 600),
      ttl: rateLimitTtl('publicRead', 60),
    },
  })
  @Get(':id/comments')
  async listComments(
    @OptionalCurrentUserId() userId: string | undefined,
    @Param('id') id: string,
    @Query() query: unknown,
    @Res({ passthrough: true }) httpRes: Response,
  ) {
    const viewerUserId = userId ?? null;
    const parsed = z
      .object({
        limit: z.coerce.number().int().min(1).max(50).optional(),
        cursor: z.string().optional(),
        visibility: z.enum(['all', 'public', 'verifiedOnly', 'premiumOnly']).optional(),
        sort: z.enum(['new', 'popular', 'trending']).optional(),
      })
      .parse(query);
    const sortKind = parsed.sort === 'trending' ? 'popular' : (parsed.sort ?? 'new');
    const result = await this.posts.listComments({
      viewerUserId,
      postId: id,
      limit: parsed.limit ?? 30,
      cursor: parsed.cursor ?? null,
      visibility: (parsed.visibility as 'all' | 'public' | 'verifiedOnly' | 'premiumOnly') ?? 'all',
      sort: sortKind as 'new' | 'popular',
    });
    const commentIds = result.comments.map((p) => p.id);
    const viewer = await this.posts.viewerContext(viewerUserId);
    const viewerHasAdmin = Boolean(viewer?.siteAdmin);
    const [boosted, bookmarksByPostId, votedPollOptionIdByPostId, internalByPostId, scoreByPostIdComments] =
      await Promise.all([
        viewerUserId
          ? this.posts.viewerBoostedPostIds({ viewerUserId, postIds: commentIds })
          : Promise.resolve(new Set<string>()),
        viewerUserId
          ? this.posts.viewerBookmarksByPostId({ viewerUserId, postIds: commentIds })
          : Promise.resolve(new Map<string, { collectionIds: string[] }>()),
        viewerUserId
          ? this.posts.viewerVotedPollOptionIdByPostId({ viewerUserId, postIds: commentIds })
          : Promise.resolve(new Map<string, string>()),
        viewerHasAdmin ? this.posts.ensureBoostScoresFresh(commentIds) : Promise.resolve(null),
        viewerHasAdmin ? this.posts.computeScoresForPostIds(commentIds) : Promise.resolve(undefined),
      ]);

    const r2comments = this.appConfig.r2()?.publicBaseUrl ?? null;

    // Collect unique parentIds and communityGroupIds from comments so we can:
    //   (a) attach parent chain info ("Replying to @username" in the reply preview)
    //   (b) attach group preview chip (same as the main feed)
    const uniqueParentIds = [
      ...new Set(
        result.comments
          .map((p) => String((p as { parentId?: string | null }).parentId ?? '').trim())
          .filter(Boolean),
      ),
    ];
    const uniqueGroupIds = [
      ...new Set(
        result.comments
          .map((p) => String((p as { communityGroupId?: string | null }).communityGroupId ?? '').trim())
          .filter(Boolean),
      ),
    ];

    const [parentPosts, groupPreviewByGroupId] = await Promise.all([
      uniqueParentIds.length
        ? this.posts.getByIds({ viewerUserId, ids: uniqueParentIds })
        : Promise.resolve([]),
      uniqueGroupIds.length
        ? this.communityGroupPreviewMapForIds(viewerUserId, uniqueGroupIds)
        : Promise.resolve(new Map<string, CommunityGroupPreviewDto>()),
    ]);
    const parentMap = new Map(parentPosts.map((p) => [p.id, p] as const));
    const videoEmbedByPostId = await this.posts.videoEmbedsForPosts([...result.comments, ...parentPosts]);

    const attachParentChain = buildAttachParentChain({
      parentMap: parentMap as any,
      baseUrl: r2comments,
      boosted,
      bookmarksByPostId,
      votedPollOptionIdByPostId,
      viewerUserId,
      viewerHasAdmin,
      internalByPostId,
      scoreByPostId: scoreByPostIdComments,
      toPostDto,
      groupPreviewByGroupId,
      videoEmbedByPostId,
    });

    setReadCache(httpRes, { viewerUserId });
    return {
      data: result.comments.map((p) => attachParentChain(p as any)),
      pagination: { nextCursor: result.nextCursor, counts: result.counts ?? null },
    };
  }

  @UseGuards(OptionalAuthGuard)
  @Throttle({
    default: {
      limit: rateLimitLimit('publicRead', 600),
      ttl: rateLimitTtl('publicRead', 60),
    },
  })
  @Get(':id/thread-participants')
  async getThreadParticipants(@OptionalCurrentUserId() userId: string | undefined, @Param('id') id: string) {
    const viewerUserId = userId ?? null;
    const result = await this.posts.getThreadParticipants({ viewerUserId, postId: id });
    return { data: result.participants };
  }

  @UseGuards(OptionalAuthGuard)
  @Throttle({
    default: {
      limit: rateLimitLimit('publicRead', 600),
      ttl: rateLimitTtl('publicRead', 60),
    },
  })
  @Get(':id')
  async getById(
    @OptionalCurrentUserId() userId: string | undefined,
    @Param('id') id: string,
    @Res({ passthrough: true }) httpRes: Response,
  ) {
    const viewerUserId = userId ?? null;

    // Try to fetch the post with normal access rules; if forbidden (tier too low),
    // fall back to a stripped preview so /p/:id can still render the gated treatment.
    let viewerCanAccess = true;
    let post: Awaited<ReturnType<typeof this.posts.getById>>;
    try {
      post = await this.posts.getById({ viewerUserId, id });
    } catch (e) {
      if (e instanceof ForbiddenException) {
        post = await this.posts.getByIdNoAccess(id);
        viewerCanAccess = false;
      } else {
        throw e;
      }
    }

    const gatedGroupId =
      !viewerCanAccess && (post as { communityGroupId?: string | null }).communityGroupId
        ? String((post as { communityGroupId?: string | null }).communityGroupId)
        : null;
    const [viewer, groupPreview] = await Promise.all([
      this.posts.viewerContext(viewerUserId),
      gatedGroupId
        ? this.posts.communityGroupPreviewForGroup(gatedGroupId, viewerUserId)
        : Promise.resolve(null),
    ]);
    const viewerHasAdmin = Boolean(viewer?.siteAdmin);

    const { chain, gatedChainIndices, byId, repostedPostRaw } = await this.loadPermalinkRelatedPosts({
      viewerUserId,
      viewerHasAdmin,
      leaf: post,
      leafGated: !viewerCanAccess,
    });

    // Build groupPreview map for any group post in the chain (including reposted) so the
    // permalink page can show the group context (back-strip, inline pill, nav highlight)
    // even when the viewer can access the post. Mirrors feed-list behavior.
    const allChainPostsForGroups: Awaited<ReturnType<typeof this.posts.getById>>[] = [
      ...chain,
      ...(repostedPostRaw ? [repostedPostRaw] : []),
    ];
    const groupIdsForPreview = Array.from(
      new Set(
        allChainPostsForGroups
          .map((p) => String((p as { communityGroupId?: string | null }).communityGroupId ?? '').trim())
          .filter((gid): gid is string => Boolean(gid)),
      ),
    );
    const allPosts = [...chain, ...(repostedPostRaw ? [repostedPostRaw] : [])];
    const postIds = allPosts.map((p) => p.id);

    // Quoted posts were batched with the ancestor chain (getByIds + gated fallback).
    const quotedPostIds = Array.from(
      new Set(
        allPosts
          .map((p) => (p as { quotedPostId?: string | null }).quotedPostId)
          .filter((qid): qid is string => Boolean(qid)),
      ),
    );
    const quotedPostByIdPermalink = new Map<string, Awaited<ReturnType<typeof this.posts.getById>>>();
    for (const qid of quotedPostIds) {
      const qp = byId.get(qid);
      if (qp) quotedPostByIdPermalink.set(qid, qp);
    }
    const [
      groupPreviewById,
      boosted,
      bookmarksByPostId,
      votedPollOptionIdByPostId,
      repostedByPostId,
      lastSeenAtByPostId,
      internalByPostId,
      scoreByPostIdGet,
    ] = await Promise.all([
      groupIdsForPreview.length
        ? this.communityGroupPreviewMapForIds(viewerUserId, groupIdsForPreview)
        : Promise.resolve(new Map<string, CommunityGroupPreviewDto>()),
      viewerUserId
        ? this.posts.viewerBoostedPostIds({ viewerUserId, postIds })
        : Promise.resolve(new Set<string>()),
      viewerUserId
        ? this.posts.viewerBookmarksByPostId({ viewerUserId, postIds })
        : Promise.resolve(new Map<string, { collectionIds: string[] }>()),
      viewerUserId
        ? this.posts.viewerVotedPollOptionIdByPostId({ viewerUserId, postIds })
        : Promise.resolve(new Map<string, string>()),
      viewerUserId
        ? this.posts.viewerRepostedPostIds({ viewerUserId, postIds })
        : Promise.resolve(new Set<string>()),
      viewerUserId
        ? this.posts.viewerLastSeenAtByPostId({ viewerUserId, postIds })
        : Promise.resolve(new Map<string, Date>()),
      viewerHasAdmin ? this.posts.ensureBoostScoresFresh(postIds) : Promise.resolve(null),
      viewerHasAdmin ? this.posts.computeScoresForPostIds(postIds) : Promise.resolve(undefined),
    ]);
    const viewedByPostId = new Set(lastSeenAtByPostId.keys());
    const videoEmbedByPostId = await this.posts.videoEmbedsForPosts([
      ...allPosts,
      ...quotedPostByIdPermalink.values(),
    ]);

    const r2 = this.appConfig.r2()?.publicBaseUrl ?? null;
    const toDto = (
      p: (typeof chain)[number],
      opts: {
        parent?: ReturnType<typeof toPostDto>;
        repostedPost?: ReturnType<typeof toPostDto>;
        isGatedRoot?: boolean;
        groupPreview?: Awaited<ReturnType<PostsService['communityGroupPreviewForGroup']>>;
      },
    ) => {
      const base = internalByPostId?.get(p.id);
      const score = scoreByPostIdGet?.get(p.id);
      const pWithPoll = p as { user?: { id?: string }; poll?: { creatorSkippedAt?: Date | null } };
      const viewerCreatorSkipped =
        Boolean(viewerUserId) &&
        pWithPoll.user?.id === viewerUserId &&
        Boolean(pWithPoll.poll?.creatorSkippedAt);
      // Prefer the gated-root preview (existing behavior) but fall back to per-post
      // group preview so accessible group posts also surface their group context.
      const ownGroupId = String((p as { communityGroupId?: string | null }).communityGroupId ?? '').trim();
      const ownGroupPreview = ownGroupId ? groupPreviewById.get(ownGroupId) ?? null : null;
      const resolvedGroupPreview = opts.isGatedRoot
        ? opts.groupPreview ?? null
        : ownGroupPreview ?? undefined;
      const quotedPostIdVal = (p as any).quotedPostId as string | null | undefined;
      const quotedPostFromMap = quotedPostIdVal ? quotedPostByIdPermalink.get(quotedPostIdVal) : undefined;
      const quotedPostDto = quotedPostFromMap
        ? toPostDto(quotedPostFromMap as any, r2, {
            videoEmbed: videoEmbedByPostId.get(quotedPostFromMap.id) ?? null,
          })
        : undefined;
      const dto = toPostDto(p, r2, {
        viewerHasBoosted: boosted.has(p.id),
        viewerHasBookmarked: bookmarksByPostId.has(p.id),
        viewerBookmarkCollectionIds: bookmarksByPostId.get(p.id)?.collectionIds ?? [],
        viewerVotedPollOptionId: votedPollOptionIdByPostId.get(p.id) ?? null,
        viewerHasReposted: repostedByPostId.has(p.id),
        viewerHasViewed: viewedByPostId.has(p.id),
        viewerLastSeenAt: lastSeenAtByPostId.get(p.id)?.toISOString(),
        viewerCreatorSkipped: viewerCreatorSkipped || undefined,
        internalOverride:
          base || (typeof score === 'number' ? { score } : undefined)
            ? { ...base, ...(typeof score === 'number' ? { score } : {}) }
            : undefined,
        repostedPost: opts.repostedPost,
        quotedPost: quotedPostDto,
        // Only the root (requested) post is gated; ancestors are accessible.
        viewerCanAccess: opts.isGatedRoot ? false : undefined,
        groupPreview: resolvedGroupPreview,
        videoEmbed: videoEmbedByPostId.get(p.id) ?? null,
      });
      return opts.parent ? { ...dto, parent: opts.parent } : dto;
    };

    // Build reposted post DTO first (if this is a flat repost).
    const repostedPostDto = repostedPostRaw ? toDto(repostedPostRaw as any, {}) : undefined;

    // Build from root down: chain[chain.length-1] is root, chain[0] is leaf (the post we're viewing).
    // A chain entry is gated when either (a) the leaf was inaccessible (!viewerCanAccess && i===0)
    // or (b) an ancestor was fetched via getByIdNoAccess because the viewer's tier was too low.
    const rootIdx = chain.length - 1;
    let dto = toDto(chain[rootIdx], {
      repostedPost: repostedPostDto,
      isGatedRoot: gatedChainIndices.has(rootIdx),
      groupPreview: gatedChainIndices.has(rootIdx) ? groupPreview ?? undefined : undefined,
    });
    for (let i = chain.length - 2; i >= 0; i--) {
      const isGated = (!viewerCanAccess && i === 0) || gatedChainIndices.has(i);
      dto = toDto(chain[i], { parent: dto, isGatedRoot: isGated, groupPreview: isGated ? groupPreview ?? undefined : undefined });
    }
    // Single-post case (no parent): the chain has only one entry, already built above.
    if (!viewerCanAccess && chain.length === 1) {
      // Rebuild with gated flag
      dto = toDto(chain[0], { repostedPost: repostedPostDto, isGatedRoot: true, groupPreview });
    }

    setReadCache(httpRes, { viewerUserId });
    return { data: dto };
  }

  @UseGuards(OptionalAuthGuard)
  @Throttle(readThrottle)
  @Get(':id/reposts')
  async listReposters(
    @OptionalCurrentUserId() userId: string | undefined,
    @Param('id') id: string,
    @Query() query: unknown,
    @Res({ passthrough: true }) httpRes: Response,
  ) {
    const { cursor, limit } = z
      .object({ cursor: z.string().optional(), limit: z.coerce.number().int().min(1).max(50).optional() })
      .parse(query);
    const viewerUserId = userId ?? null;
    const result = await this.posts.listReposters({ viewerUserId, postId: id, limit: limit ?? 30, cursor: cursor ?? null });
    setReadCache(httpRes, { viewerUserId });
    return { data: result.authors, pagination: { nextCursor: result.nextCursor } };
  }

  @UseGuards(OptionalAuthGuard)
  @Throttle(readThrottle)
  @Get(':id/quotes')
  async listQuotes(
    @OptionalCurrentUserId() userId: string | undefined,
    @Param('id') id: string,
    @Query() query: unknown,
    @Res({ passthrough: true }) httpRes: Response,
  ) {
    const { cursor, limit } = z
      .object({ cursor: z.string().optional(), limit: z.coerce.number().int().min(1).max(50).optional() })
      .parse(query);
    const viewerUserId = userId ?? null;
    const result = await this.posts.listQuotes({ viewerUserId, postId: id, limit: limit ?? 20, cursor: cursor ?? null });
    const r2BaseUrl = this.appConfig.r2()?.publicBaseUrl ?? null;
    const allPostIds = result.posts.map((p) => p.id);
    const viewerRepostedPostIds = viewerUserId
      ? await this.posts.viewerRepostedPostIds({ viewerUserId, postIds: allPostIds })
      : new Set<string>();
    const dtos = result.posts.map((p) =>
      toPostDto(p, r2BaseUrl, {
        viewerHasReposted: viewerRepostedPostIds.has(p.id),
      }),
    );
    setReadCache(httpRes, { viewerUserId });
    return { data: dtos, pagination: { nextCursor: result.nextCursor } };
  }

  @UseGuards(OptionalAuthGuard)
  @Throttle(readThrottle)
  @Get(':id/discover-more')
  async listDiscoverMore(
    @OptionalCurrentUserId() userId: string | undefined,
    @Param('id') id: string,
    @Query() query: unknown,
    @Res({ passthrough: true }) httpRes: Response,
  ) {
    const { cursor, limit, seed } = z
      .object({
        cursor: z.string().optional(),
        limit: z.coerce.number().int().min(1).max(50).optional(),
        /** Opaque client seed for soft shuffle; reuse across pages, rotate on remount. */
        seed: z.string().trim().min(1).max(64).optional(),
      })
      .parse(query);
    const viewerUserId = userId ?? null;
    const result = await this.posts.listDiscoverMore({
      viewerUserId,
      postId: id,
      limit: limit ?? 8,
      cursor: cursor ?? null,
      shuffleSeed: seed ?? null,
    });
    setReadCache(httpRes, { viewerUserId });
    return { data: result.posts, pagination: { nextCursor: result.nextCursor } };
  }

  @UseGuards(AuthGuard)
  @Throttle({
    default: {
      limit: rateLimitLimit('postCreate', 30),
      ttl: rateLimitTtl('postCreate', 60),
    },
  })
  @Post()
  async create(
    @Body() body: unknown,
    @CurrentUserId() userId: string,
    @Headers('x-marv-mode') marvModeHeader?: string,
  ) {
    const parsed = createSchema.parse(body);
    const marvMode = parseMarvModeHeader(marvModeHeader);
    const media = (parsed.media ?? null) as CreateMediaItem[] | null;
    const poll =
      parsed.poll
        ? (() => {
            const d = parsed.poll!.duration;
            const totalSeconds = d.days * 24 * 60 * 60 + d.hours * 60 * 60 + d.minutes * 60;
            return {
              endsAt: new Date(Date.now() + totalSeconds * 1000),
              options: parsed.poll!.options.map((o) => ({
                text: (o.text ?? '').trim(),
                image: o.image
                  ? {
                      r2Key: o.image.r2Key,
                      width: typeof o.image.width === 'number' ? o.image.width : null,
                      height: typeof o.image.height === 'number' ? o.image.height : null,
                      alt: (o.image.alt ?? '').trim() || null,
                    }
                  : null,
              })),
            };
          })()
        : null;
    const { post: created, streakReward } = await this.posts.createPost({
      userId,
      body: (parsed.body ?? '').trim(),
      visibility: parsed.visibility ?? 'public',
      parentId: parsed.parent_id ?? null,
      communityGroupId: parsed.community_group_id ?? null,
      mentions: parsed.mentions ?? null,
      media,
      poll,
      marvMode,
    });

    const viewer = await this.posts.viewerContext(userId);
    const viewerHasAdmin = Boolean(viewer?.siteAdmin);
    return {
      data: {
        post: toPostDto(created, this.appConfig.r2()?.publicBaseUrl ?? null, {
          viewerHasBoosted: false,
          includeInternal: viewerHasAdmin,
        }),
        streakReward: streakReward ?? null,
      },
    };
  }

  @UseGuards(AuthGuard)
  @Throttle({
    default: {
      limit: rateLimitLimit('interact', 180),
      ttl: rateLimitTtl('interact', 60),
    },
  })
  @Delete(':id')
  async delete(@Param('id') id: string, @CurrentUserId() userId: string) {
    const result = await this.posts.deletePost({ userId, postId: id });
    return { data: result };
  }

  @UseGuards(AuthGuard)
  @Throttle({
    default: {
      limit: rateLimitLimit('interact', 180),
      ttl: rateLimitTtl('interact', 60),
    },
  })
  @Patch(':id')
  async update(@Param('id') id: string, @Body() body: unknown, @CurrentUserId() userId: string) {
    const parsed = updateSchema.parse(body);
    const viewer = await this.posts.viewerContext(userId);
    const viewerHasAdmin = Boolean(viewer?.siteAdmin);
    const updated = await this.posts.updatePost({ userId, postId: id, body: (parsed.body ?? '').trim(), isSiteAdmin: viewerHasAdmin });

    return {
      data: toPostDto(updated, this.appConfig.r2()?.publicBaseUrl ?? null, {
        viewerHasBoosted: false,
        includeInternal: viewerHasAdmin,
      }),
    };
  }

  @UseGuards(AuthGuard)
  @Throttle({
    default: {
      limit: rateLimitLimit('postCreate', 30),
      ttl: rateLimitTtl('postCreate', 60),
    },
  })
  @Post(':id/publish-from-only-me')
  async publishFromOnlyMe(@Param('id') id: string, @Body() body: unknown, @CurrentUserId() userId: string) {
    const parsed = publishFromOnlyMeSchema.parse(body);
    const created = await this.posts.publishFromOnlyMe({
      userId,
      sourcePostId: id,
      body: typeof parsed.body === 'string' ? parsed.body.trim() : null,
      visibility: parsed.visibility,
      media: (parsed as any).media ?? null,
    });
    const viewer = await this.posts.viewerContext(userId);
    const viewerHasAdmin = Boolean(viewer?.siteAdmin);
    return {
      data: toPostDto(created, this.appConfig.r2()?.publicBaseUrl ?? null, {
        viewerHasBoosted: false,
        includeInternal: viewerHasAdmin,
      }),
    };
  }

  @UseGuards(AuthGuard)
  @Throttle({
    default: {
      limit: rateLimitLimit('interact', 180),
      ttl: rateLimitTtl('interact', 60),
    },
  })
  @Post(':id/boost')
  async boost(@Param('id') id: string, @CurrentUserId() userId: string) {
    const result = await this.posts.boostPost({ userId, postId: id });
    return { data: result };
  }

  @UseGuards(AuthGuard)
  @Throttle({
    default: {
      limit: rateLimitLimit('interact', 180),
      ttl: rateLimitTtl('interact', 60),
    },
  })
  @Delete(':id/boost')
  async unboost(@Param('id') id: string, @CurrentUserId() userId: string) {
    const result = await this.posts.unboostPost({ userId, postId: id });
    return { data: result };
  }

  @UseGuards(AuthGuard)
  @Throttle({
    default: {
      limit: rateLimitLimit('interact', 180),
      ttl: rateLimitTtl('interact', 60),
    },
  })
  @Post(':id/repost')
  async repost(@Param('id') id: string, @CurrentUserId() userId: string) {
    const result = await this.posts.repostPost({ userId, postId: id });
    return { data: result };
  }

  @UseGuards(AuthGuard)
  @Throttle({
    default: {
      limit: rateLimitLimit('interact', 180),
      ttl: rateLimitTtl('interact', 60),
    },
  })
  @Delete(':id/repost')
  async unrepost(@Param('id') id: string, @CurrentUserId() userId: string) {
    const result = await this.posts.unrepostPost({ userId, postId: id });
    return { data: result };
  }

  @UseGuards(AuthGuard)
  @Throttle({
    default: {
      limit: rateLimitLimit('interact', 180),
      ttl: rateLimitTtl('interact', 60),
    },
  })
  @Post(':id/poll/vote')
  async voteOnPoll(@Param('id') id: string, @Body() body: unknown, @CurrentUserId() userId: string) {
    const parsed = z
      .object({
        optionId: z.string().cuid(),
      })
      .parse(body);
    const result = await this.posts.voteOnPoll({ userId, postId: id, optionId: parsed.optionId });
    return {
      data: {
        poll: toPostPollDto(result.poll as any, this.appConfig.r2()?.publicBaseUrl ?? null, {
          viewerVotedOptionId: result.viewerVotedOptionId,
        }),
      },
    };
  }

  @UseGuards(AuthGuard)
  @Throttle({
    default: {
      limit: rateLimitLimit('interact', 180),
      ttl: rateLimitTtl('interact', 60),
    },
  })
  @Post(':id/poll/skip')
  async skipPoll(@Param('id') id: string, @CurrentUserId() userId: string) {
    const result = await this.posts.skipPoll({ userId, postId: id });
    return {
      data: {
        poll: toPostPollDto(result.poll as any, this.appConfig.r2()?.publicBaseUrl ?? null, {
          viewerVotedOptionId: null,
          viewerSkipped: true,
        }),
      },
    };
  }
}

