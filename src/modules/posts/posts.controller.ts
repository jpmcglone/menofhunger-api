import type { CrosspostMode } from '@prisma/client';
import { PickaxCrosspostService } from '../pickax/pickax-crosspost.service';
import { XCrosspostService } from '../x/x-crosspost.service';
import { Body, Controller, Delete, Get, Headers, Logger, Param, Patch, Post, Query, Res, UseGuards } from '@nestjs/common';
import { z } from 'zod';
import { ApiTags } from '@nestjs/swagger';
import { Throttle } from '@nestjs/throttler';
import type { Response } from 'express';
import { AuthGuard } from '../auth/auth.guard';
import { OptionalAuthGuard } from '../auth/optional-auth.guard';
import { AppConfigService } from '../app/app-config.service';
import { CurrentUserId, OptionalCurrentUserId } from '../users/users.decorator';
import { PostsService } from './posts.service';
import { listSchema, listPostsOn } from './posts-list.query';
import { getPostByIdOn, loadPermalinkRelatedPostsOn } from './posts-get.query';
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
    /** Also publish to the author's connected Pickax account when the post qualifies. */
    crossPostToPickax: z.boolean().optional(),
    /** Per-destination choice. `crossPostToPickax: true` still means a full Pickax post. */
    crosspost: z.object({
      pickax: z.enum(['link', 'native']).optional(),
      x: z.literal('native').optional(),
    }).optional(),
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
  readonly logger = new Logger(PostsController.name);

  constructor(
    readonly posts: PostsService,
    readonly appConfig: AppConfigService,
    readonly cache: CacheService,
    readonly cacheInvalidation: CacheInvalidationService,
    private readonly pickax: PickaxCrosspostService,
    private readonly x: XCrosspostService,
  ) {}

  async communityGroupPreviewMapForIds(
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
  async loadPermalinkRelatedPosts(params: {
    viewerUserId: string | null;
    viewerHasAdmin: boolean;
    leaf: Awaited<ReturnType<PostsService['getById']>>;
    leafGated: boolean;
  }) {
    return loadPermalinkRelatedPostsOn(this, params);
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
    return listPostsOn(this, userId, query, httpRes);
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
    return getPostByIdOn(this, userId, id, httpRes);
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
    const dtos = await this.posts.composeFeedPostDtos({
      viewerUserId,
      filteredPosts: result.posts,
      collapsedItemsByItemId: new Map(),
    });
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
      crosspost: parsed.crosspost ?? (parsed.crossPostToPickax ? { pickax: 'native' } : undefined),
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

    const pickaxMode: CrosspostMode | null = parsed.crosspost?.pickax ?? (parsed.crossPostToPickax ? 'native' : null);
    const xMode = parsed.crosspost?.x ?? null;
    const pickax = pickaxMode ? await this.pickax.requestPostCrosspost(userId, created.id, pickaxMode) : null;
    const x = xMode ? await this.x.requestPostCrosspost(userId, created.id, xMode) : null;

    const viewer = await this.posts.viewerContext(userId);
    const viewerHasAdmin = Boolean(viewer?.siteAdmin);
    return {
      data: {
        pickax,
        crossposts: { pickax, x },
        post: toPostDto(created, this.appConfig.r2()?.publicBaseUrl ?? null, {
          viewerHasBoosted: false,
          includeInternal: viewerHasAdmin,
          viewerIsAuthor: true,
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
    await this.pickax.requestPostUpdate(userId, id);

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

