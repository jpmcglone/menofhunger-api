import { Body, Controller, Delete, ForbiddenException, Get, Logger, Param, Patch, Post, Query, Res, UseGuards } from '@nestjs/common';
import { z } from 'zod';
import { Throttle } from '@nestjs/throttler';
import type { Response } from 'express';
import { AuthGuard } from '../auth/auth.guard';
import { OptionalAuthGuard } from '../auth/optional-auth.guard';
import { AppConfigService } from '../app/app-config.service';
import { CurrentUserId, OptionalCurrentUserId } from '../users/users.decorator';
import { PostsService } from './posts.service';
import { toPostDto, toPostPollDto } from './post.dto';
import { buildAttachParentChain } from './posts.utils';
import { rateLimitLimit, rateLimitTtl } from '../../common/throttling/rate-limit.resolver';
import { setReadCache } from '../../common/http-cache';
import { CacheInvalidationService } from '../redis/cache-invalidation.service';
import { RedisKeys, stableJsonHash } from '../redis/redis-keys';
import { CacheService } from '../redis/cache.service';
import { CacheTtl } from '../redis/cache-ttl';
import { collapseFeedByRoot } from '../../common/feed-collapse/collapse-by-root';
import type { CommunityGroupPreviewDto } from '../../common/dto/community-group.dto';

const readThrottle = {
  default: {
    limit: rateLimitLimit('read', 120),
    ttl: rateLimitTtl('read', 60),
  },
};

const listSchema = z.object({
  limit: z.coerce.number().int().min(1).max(50).optional(),
  cursor: z.string().optional(),
  visibility: z.enum(['all', 'public', 'verifiedOnly', 'premiumOnly']).optional(),
  followingOnly: z.coerce.boolean().optional(),
  kind: z.enum(['regular', 'checkin']).optional(),
  // Optional author filter (comma-separated user IDs). Used by Explore to show trending by recommended users.
  authorIds: z.string().optional(),
  // "trending" is the UI-friendly name for our half-life boost scoring feed.
  // Keep "popular" for backwards compatibility / internal naming.
  // "forYou" is a personalized re-rank of trending using the viewer's follow graph + view history.
  sort: z.enum(['new', 'popular', 'trending', 'featured', 'forYou']).optional(),
  collapseByRoot: z.coerce.boolean().optional(),
  collapseMode: z.enum(['root', 'parent']).optional(),
  prefer: z.enum(['reply', 'root']).optional(),
  collapseMaxPerRoot: z.coerce.number().int().min(1).max(5).optional(),
  /** All groups the viewer is in (members-only). Mutually exclusive with `communityGroupId` in practice. */
  groupsHub: z.coerce.boolean().optional(),
  /** Single community group feed (members-only). */
  communityGroupId: z.string().trim().min(1).max(40).optional(),
  /** When true and a group-scoped request, return only top-level (non-reply) posts. */
  topLevelOnly: z.coerce.boolean().optional(),
});

const userListSchema = listSchema.extend({
  visibility: z.enum(['all', 'public', 'verifiedOnly', 'premiumOnly']).optional(),
  includeCounts: z.coerce.boolean().optional(),
  topLevelOnly: z.coerce.boolean().optional(),
  includeRestricted: z.coerce.boolean().optional(),
});

const userMediaListSchema = z.object({
  limit: z.coerce.number().int().min(1).max(50).optional(),
  cursor: z.string().optional(),
  visibility: z.enum(['all', 'public', 'verifiedOnly', 'premiumOnly']).optional(),
  sort: z.enum(['new', 'trending']).optional(),
  includeRestricted: z.coerce.boolean().optional(),
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

@Controller('posts')
export class PostsController {
  private readonly logger = new Logger(PostsController.name);

  constructor(
    private readonly posts: PostsService,
    private readonly appConfig: AppConfigService,
    private readonly cache: CacheService,
    private readonly cacheInvalidation: CacheInvalidationService,
  ) {}

  private async collectParentMap(viewerUserId: string | null, seedParentIds: Array<string | null | undefined>) {
    return this.posts.collectParentMapForFeed(viewerUserId, seedParentIds);
  }

  private async collectRepostedMap(viewerUserId: string | null, repostedPostIds: string[]) {
    return this.posts.collectRepostedMapForFeed(viewerUserId, repostedPostIds);
  }

  private async communityGroupPreviewMapForIds(
    viewerUserId: string | null,
    groupIds: string[],
  ): Promise<Map<string, CommunityGroupPreviewDto>> {
    return this.posts.communityGroupPreviewMapForFeed(viewerUserId, groupIds);
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

    const sort = parsed.sort ?? 'new';
    const requestedSortKind = sort === 'trending' ? 'popular' : sort;
    // Anonymous /home is framed as For You in the UI, but without a viewer we fall back
    // to the public discovery ranking instead of rejecting the feed request.
    const sortKind = requestedSortKind === 'forYou' && !viewerUserId ? 'popular' : requestedSortKind;
    const isForYou = sortKind === 'forYou';

    const groupScoped = Boolean(parsed.groupsHub || parsed.communityGroupId);
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

    // For You is per-user and depends on view history that changes constantly — no caching.
    const anonCache = !isForYou && viewerUserId == null;
    const authFirstPageCache = !isForYou && Boolean(viewerUserId) && !cursor;
    const authCursorCache = !isForYou
      && Boolean(viewerUserId)
      && Boolean(cursor)
      && (sortKind === 'new' || sortKind === 'popular' || sortKind === 'featured')
      && !authorUserIds.length
      && !(parsed.kind ?? null)
      && !(parsed.followingOnly ?? false)
      && String(cursor).trim().length <= 64;
    const feedVer = (anonCache || authFirstPageCache || authCursorCache)
      ? await this.cacheInvalidation.feedGlobalVersion()
      : null;
    const cacheEnabled = Boolean(feedVer) && (anonCache || authFirstPageCache || authCursorCache);
    const paramsHash = cacheEnabled
      ? stableJsonHash({
          endpoint: 'posts:list',
          sort: sortKind,
          limit,
          cursor,
          visibility: parsed.visibility ?? 'all',
          followingOnly: parsed.followingOnly ?? false,
          kind: parsed.kind ?? null,
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

    const out = await this.cache.getOrSetJson<{ data: any; pagination: any }>({
      enabled: cacheEnabled && Boolean(cacheKey),
      key: cacheKey ?? '',
      ttlSeconds: anonCache
        ? CacheTtl.anonFeedSeconds
        : (authFirstPageCache ? CacheTtl.authFeedSeconds : CacheTtl.authCursorFeedSeconds),
      compute: async () => {
        const listStartMs = Date.now();
        const result =
          sortKind === 'forYou'
            ? await this.posts.listForYouFeed({
                viewerUserId: viewerUserId!,
                limit,
                cursor,
                visibility: parsed.visibility ?? 'all',
                kind: parsed.kind ?? null,
                authorUserIds: authorUserIds.length ? authorUserIds : null,
              })
            : sortKind === 'featured'
              ? await this.posts.listFeaturedFeed({
                  viewerUserId,
                  limit,
                  cursor,
                  visibility: parsed.visibility ?? 'all',
                  followingOnly: parsed.followingOnly ?? false,
                  kind: parsed.kind ?? null,
                  authorUserIds: authorUserIds.length ? authorUserIds : null,
                })
              : sortKind === 'popular'
                ? await this.posts.listPopularFeed({
                    viewerUserId,
                    limit,
                    cursor,
                    visibility: parsed.visibility ?? 'all',
                    followingOnly: parsed.followingOnly ?? false,
                    kind: parsed.kind ?? null,
                    authorUserIds: authorUserIds.length ? authorUserIds : null,
                  })
                : await this.posts.listFeed({
                    viewerUserId,
                    limit,
                    cursor,
                    visibility: parsed.visibility ?? 'all',
                    followingOnly: parsed.followingOnly ?? false,
                    kind: parsed.kind ?? null,
                    authorUserIds: authorUserIds.length ? authorUserIds : null,
                  });
        stageMs.list = Date.now() - listStartMs;

        // For the chronological feed, suppress the original post when the viewer's own
        // repost of it also appears in the same page — keeping only the repost (which
        // is newer and already carries the original content inside repostedPost).
        // Popular/featured feeds already exclude kind='repost' rows, so this is a no-op there.
        const dedupedPosts = (() => {
          const repostedOriginalIds = new Set(
            result.posts
              .filter((p) => (p as { kind?: string }).kind === 'repost' && (p as { repostedPostId?: string | null }).repostedPostId)
              .map((p) => (p as { repostedPostId: string }).repostedPostId),
          );
          if (repostedOriginalIds.size === 0) return result.posts;
          return result.posts.filter(
            (p) => (p as { kind?: string }).kind === 'repost' || !repostedOriginalIds.has(p.id),
          );
        })();

        const dedupeStartMs = Date.now();
        const { items: filteredPosts, collapsedCountByItemId } = collapseFeedByRoot(dedupedPosts, {
          collapseByRoot: parsed.collapseByRoot ?? false,
          collapseMode: parsed.collapseMode ?? 'root',
          prefer: parsed.prefer ?? 'reply',
          maxPerRoot: parsed.collapseMaxPerRoot ?? 1,
          getId: (post) => post.id,
          getParentId: (post) => post.parentId ?? null,
        });
        stageMs.dedupe = Date.now() - dedupeStartMs;
        const dtoStartMs = Date.now();
        const popResult = result as { scoreByPostId?: Map<string, number> };
        const dtos = await this.posts.composeFeedPostDtos({
          viewerUserId,
          filteredPosts,
          collapsedCountByItemId,
          scoreByPostId: popResult.scoreByPostId,
        });
        const payload = {
          data: dtos,
          pagination: { nextCursor: result.nextCursor },
        };
        stageMs.dto = Date.now() - dtoStartMs;
        return payload;
      },
    });

    const totalMs = Date.now() - reqStartMs;
    httpRes.setHeader('x-feed-total-ms', String(totalMs));
    if (Object.keys(stageMs).length > 0) {
      const serverTiming = Object.entries(stageMs)
        .filter(([, ms]) => Number.isFinite(ms))
        .map(([name, ms]) => `${name};dur=${Math.max(0, Math.round(ms))}`)
        .join(', ');
      if (serverTiming) httpRes.setHeader('server-timing', serverTiming);
    }
    httpRes.setHeader(
      'x-feed-cache-mode',
      anonCache
        ? 'anon'
        : (authFirstPageCache ? 'auth_first_page' : (authCursorCache ? 'auth_cursor' : 'none')),
    );
    if (totalMs >= 800) {
      this.logger.warn(`GET /posts slow request: ${totalMs}ms (sort=${sortKind}, cursor=${cursor ? 'yes' : 'no'}, mode=${anonCache ? 'anon' : (authFirstPageCache ? 'auth_first_page' : (authCursorCache ? 'auth_cursor' : 'none'))})`);
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

        const { items: filteredPostsUser, collapsedCountByItemId: collapsedCountByItemIdUser } = collapseFeedByRoot(result.posts, {
          collapseByRoot: parsed.collapseByRoot ?? false,
          collapseMode: parsed.collapseMode ?? 'root',
          prefer: parsed.prefer ?? 'reply',
          maxPerRoot: parsed.collapseMaxPerRoot ?? 1,
          getId: (post) => post.id,
          getParentId: (post) => post.parentId ?? null,
        });
        // Fetch repost data for flat reposts.
        const repostedPostIdsUser = filteredPostsUser
          .filter((p) => (p as any).kind === 'repost' && (p as any).repostedPostId)
          .map((p) => (p as any).repostedPostId as string);
        const [viewer, parentMap, repostedPostMapUser] = await Promise.all([
          this.posts.viewerContext(viewerUserId),
          this.collectParentMap(viewerUserId, filteredPostsUser.map((p) => p.parentId)),
          this.collectRepostedMap(viewerUserId, repostedPostIdsUser),
        ]);
        const viewerHasAdmin = Boolean(viewer?.siteAdmin);

        // Compute per-post viewerCanAccess when includeRestricted=true.
        let viewerCanAccessByPostId: Map<string, boolean> | undefined;
        if (parsed.includeRestricted) {
          const allowed = this.posts.allowedVisibilities(viewer);
          viewerCanAccessByPostId = new Map(
            result.posts.map((p) => [p.id, allowed.includes(p.visibility) || p.userId === viewerUserId]),
          );
        }

        const allPostIds = [...filteredPostsUser.map((p) => p.id), ...parentMap.keys()];
        const [
          boosted,
          bookmarksByPostId,
          votedPollOptionIdByPostId,
          blockSetsUser,
          repostedByPostIdUser,
          internalByPostId,
          scoreByPostIdUser,
        ] = await Promise.all([
          viewerUserId
            ? this.posts.viewerBoostedPostIds({ viewerUserId, postIds: allPostIds })
            : Promise.resolve(new Set<string>()),
          viewerUserId
            ? this.posts.viewerBookmarksByPostId({ viewerUserId, postIds: allPostIds })
            : Promise.resolve(new Map<string, { collectionIds: string[] }>()),
          viewerUserId
            ? this.posts.viewerVotedPollOptionIdByPostId({ viewerUserId, postIds: allPostIds })
            : Promise.resolve(new Map<string, string>()),
          viewerUserId
            ? this.posts.viewerBlockSets(viewerUserId)
            : Promise.resolve({ blockedByViewer: new Set<string>(), viewerBlockedBy: new Set<string>() }),
          viewerUserId
            ? this.posts.viewerRepostedPostIds({ viewerUserId, postIds: allPostIds })
            : Promise.resolve(new Set<string>()),
          viewerHasAdmin
            ? this.posts.ensureBoostScoresFresh(filteredPostsUser.map((p) => p.id))
            : Promise.resolve(null),
          viewerHasAdmin
            ? this.posts.computeScoresForPostIds(allPostIds)
            : Promise.resolve(undefined),
        ]);
        const { blockedByViewer: blockedByViewerUser, viewerBlockedBy: viewerBlockedByUser } = blockSetsUser;

        const communityGroupIdsForUserPage = new Set<string>();
        const accCommunityGroupIdUser = (row: { communityGroupId?: string | null } | null | undefined) => {
          const g = String(row?.communityGroupId ?? '').trim();
          if (g) communityGroupIdsForUserPage.add(g);
        };
        for (const p of filteredPostsUser) accCommunityGroupIdUser(p as { communityGroupId?: string | null });
        for (const p of parentMap.values()) accCommunityGroupIdUser(p as { communityGroupId?: string | null });
        for (const p of repostedPostMapUser.values()) accCommunityGroupIdUser(p as { communityGroupId?: string | null });
        const groupPreviewByGroupIdUser = await this.communityGroupPreviewMapForIds(
          viewerUserId,
          [...communityGroupIdsForUserPage],
        );

        const baseUrl = this.appConfig.r2()?.publicBaseUrl ?? null;
        const attachParentChain = buildAttachParentChain({
          parentMap,
          baseUrl,
          boosted,
          bookmarksByPostId,
          votedPollOptionIdByPostId,
          viewerUserId,
          viewerHasAdmin,
          internalByPostId,
          scoreByPostId: scoreByPostIdUser,
          toPostDto,
          blockedByViewer: blockedByViewerUser,
          viewerBlockedBy: viewerBlockedByUser,
          repostedByPostId: repostedByPostIdUser,
          repostedPostMap: repostedPostMapUser as any,
          viewerCanAccessByPostId,
          groupPreviewByGroupId: groupPreviewByGroupIdUser,
        });

        return {
          data: filteredPostsUser.map((p) => {
            const dto = attachParentChain(p);
            const collapsed = collapsedCountByItemIdUser.get(p.id);
            if (collapsed && collapsed > 0) (dto as any).threadCollapsedCount = collapsed;
            return dto;
          }),
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
    const viewer = await this.posts.viewerContext(viewerUserId);
    const viewerHasAdmin = Boolean(viewer?.siteAdmin);
    const boosted = viewerUserId
      ? await this.posts.viewerBoostedPostIds({
          viewerUserId,
          postIds: result.comments.map((p) => p.id),
        })
      : new Set<string>();
    const bookmarksByPostId = viewerUserId
      ? await this.posts.viewerBookmarksByPostId({ viewerUserId, postIds: result.comments.map((p) => p.id) })
      : new Map<string, { collectionIds: string[] }>();
    const votedPollOptionIdByPostId = viewerUserId
      ? await this.posts.viewerVotedPollOptionIdByPostId({ viewerUserId, postIds: result.comments.map((p) => p.id) })
      : new Map<string, string>();
    const internalByPostId = viewerHasAdmin
      ? await this.posts.ensureBoostScoresFresh(result.comments.map((p) => p.id))
      : null;
    const scoreByPostIdComments =
      viewerHasAdmin ? await this.posts.computeScoresForPostIds(result.comments.map((p) => p.id)) : undefined;
    setReadCache(httpRes, { viewerUserId });
    return {
      data: result.comments.map((p) => {
        const pWithPoll = p as { user?: { id?: string }; poll?: { creatorSkippedAt?: Date | null } };
        const viewerCreatorSkipped =
          Boolean(viewerUserId) &&
          pWithPoll.user?.id === viewerUserId &&
          Boolean(pWithPoll.poll?.creatorSkippedAt);
        return toPostDto(p, this.appConfig.r2()?.publicBaseUrl ?? null, {
          viewerHasBoosted: boosted.has(p.id),
          viewerHasBookmarked: bookmarksByPostId.has(p.id),
          viewerBookmarkCollectionIds: bookmarksByPostId.get(p.id)?.collectionIds ?? [],
          viewerVotedPollOptionId: votedPollOptionIdByPostId.get(p.id) ?? null,
          viewerCreatorSkipped: viewerCreatorSkipped || undefined,
          includeInternal: viewerHasAdmin,
          internalOverride: (() => {
            const base = internalByPostId?.get(p.id);
            const score = scoreByPostIdComments?.get(p.id);
            return base || (typeof score === 'number' ? { score } : undefined)
              ? { ...base, ...(typeof score === 'number' ? { score } : {}) }
              : undefined;
          })(),
        });
      }),
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
    const groupPreview = gatedGroupId
      ? await this.posts.communityGroupPreviewForGroup(gatedGroupId, viewerUserId)
      : null;

    const viewer = await this.posts.viewerContext(viewerUserId);
    const viewerHasAdmin = Boolean(viewer?.siteAdmin);

    // Collect ancestor chain (post + all parents) for boost/bookmark and DTO building
    const chain: Awaited<ReturnType<typeof this.posts.getById>>[] = [];
    let current: Awaited<ReturnType<typeof this.posts.getById>> | null = post;
    while (current) {
      chain.push(current);
      const parentId: string | null | undefined = (current as { parentId?: string | null }).parentId;
      current = parentId ? await this.posts.getById({ viewerUserId, id: parentId }) : null;
    }

    // Also fetch the reposted post if this is a flat repost.
    const repostedPostId = (post as any).repostedPostId as string | null | undefined;
    const repostedPostRaw = repostedPostId
      ? await this.posts.getById({ viewerUserId, id: repostedPostId }).catch(() => null)
      : null;

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
    const groupPreviewById = groupIdsForPreview.length
      ? await this.communityGroupPreviewMapForIds(viewerUserId, groupIdsForPreview)
      : new Map<string, CommunityGroupPreviewDto>();

    const allPosts = [...chain, ...(repostedPostRaw ? [repostedPostRaw] : [])];
    const postIds = allPosts.map((p) => p.id);
    const boosted = viewerUserId
      ? await this.posts.viewerBoostedPostIds({ viewerUserId, postIds })
      : new Set<string>();
    const bookmarksByPostId = viewerUserId
      ? await this.posts.viewerBookmarksByPostId({ viewerUserId, postIds })
      : new Map<string, { collectionIds: string[] }>();
    const votedPollOptionIdByPostId = viewerUserId
      ? await this.posts.viewerVotedPollOptionIdByPostId({ viewerUserId, postIds })
      : new Map<string, string>();
    const repostedByPostId = viewerUserId
      ? await this.posts.viewerRepostedPostIds({ viewerUserId, postIds })
      : new Set<string>();
    const internalByPostId = viewerHasAdmin ? await this.posts.ensureBoostScoresFresh(postIds) : null;
    const scoreByPostIdGet =
      viewerHasAdmin ? await this.posts.computeScoresForPostIds(postIds) : undefined;

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
      const dto = toPostDto(p, r2, {
        viewerHasBoosted: boosted.has(p.id),
        viewerHasBookmarked: bookmarksByPostId.has(p.id),
        viewerBookmarkCollectionIds: bookmarksByPostId.get(p.id)?.collectionIds ?? [],
        viewerVotedPollOptionId: votedPollOptionIdByPostId.get(p.id) ?? null,
        viewerHasReposted: repostedByPostId.has(p.id),
        viewerCreatorSkipped: viewerCreatorSkipped || undefined,
        includeInternal: viewerHasAdmin,
        internalOverride:
          base || (typeof score === 'number' ? { score } : undefined)
            ? { ...base, ...(typeof score === 'number' ? { score } : {}) }
            : undefined,
        repostedPost: opts.repostedPost,
        // Only the root (requested) post is gated; ancestors are accessible.
        viewerCanAccess: opts.isGatedRoot ? false : undefined,
        groupPreview: resolvedGroupPreview,
      });
      return opts.parent ? { ...dto, parent: opts.parent } : dto;
    };

    // Build reposted post DTO first (if this is a flat repost).
    const repostedPostDto = repostedPostRaw ? toDto(repostedPostRaw as any, {}) : undefined;

    // Build from root down: chain[chain.length-1] is root, chain[0] is leaf (the post we're viewing)
    let dto = toDto(chain[chain.length - 1], { repostedPost: repostedPostDto });
    for (let i = chain.length - 2; i >= 0; i--) {
      // chain[0] is the leaf post (the one actually requested); mark it gated if access was denied.
      dto = toDto(chain[i], { parent: dto, isGatedRoot: !viewerCanAccess && i === 0, groupPreview });
    }
    // Single-post case (no parent): the chain has only one entry, already built above.
    if (!viewerCanAccess && chain.length === 1) {
      // Rebuild with gated flag
      dto = toDto(chain[0], { repostedPost: repostedPostDto, isGatedRoot: true, groupPreview });
    }

    setReadCache(httpRes, { viewerUserId });
    return { data: dto };
  }

  @UseGuards(AuthGuard)
  @Throttle({
    default: {
      limit: rateLimitLimit('postCreate', 30),
      ttl: rateLimitTtl('postCreate', 60),
    },
  })
  @Post()
  async create(@Body() body: unknown, @CurrentUserId() userId: string) {
    const parsed = createSchema.parse(body);
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

