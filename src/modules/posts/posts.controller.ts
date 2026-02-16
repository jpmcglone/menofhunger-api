import { Body, Controller, Delete, Get, Param, Patch, Post, Query, Res, UseGuards } from '@nestjs/common';
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

const listSchema = z.object({
  limit: z.coerce.number().int().min(1).max(50).optional(),
  cursor: z.string().optional(),
  visibility: z.enum(['all', 'public', 'verifiedOnly', 'premiumOnly']).optional(),
  followingOnly: z.coerce.boolean().optional(),
  // Optional author filter (comma-separated user IDs). Used by Explore to show trending by recommended users.
  authorIds: z.string().optional(),
  // "trending" is the UI-friendly name for our half-life boost scoring feed.
  // Keep "popular" for backwards compatibility / internal naming.
  sort: z.enum(['new', 'popular', 'trending', 'featured']).optional(),
});

const userListSchema = listSchema.extend({
  visibility: z.enum(['all', 'public', 'verifiedOnly', 'premiumOnly']).optional(),
  includeCounts: z.coerce.boolean().optional(),
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
    // Video uploads: require dimensions and duration, enforce 1440p and 5 min
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
      if (width > 2560 || height > 1440) {
        ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'Video must be 1440p or smaller.', path: ['media', i, 'width'] });
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
  constructor(
    private readonly posts: PostsService,
    private readonly appConfig: AppConfigService,
  ) {}

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
    const sortKind = sort === 'trending' ? 'popular' : sort;
    const result =
      sortKind === 'featured'
        ? await this.posts.listFeaturedFeed({
            viewerUserId,
            limit,
            cursor,
            visibility: parsed.visibility ?? 'all',
            followingOnly: parsed.followingOnly ?? false,
            authorUserIds: authorUserIds.length ? authorUserIds : null,
          })
        : sortKind === 'popular'
        ? await this.posts.listPopularFeed({
            viewerUserId,
            limit,
            cursor,
            visibility: parsed.visibility ?? 'all',
            followingOnly: parsed.followingOnly ?? false,
            authorUserIds: authorUserIds.length ? authorUserIds : null,
          })
        : await this.posts.listFeed({
            viewerUserId,
            limit,
            cursor,
            visibility: parsed.visibility ?? 'all',
            followingOnly: parsed.followingOnly ?? false,
            authorUserIds: authorUserIds.length ? authorUserIds : null,
          });

    const viewer = await this.posts.viewerContext(viewerUserId);
    const viewerHasAdmin = Boolean(viewer?.siteAdmin);
    // Dedupe: keep only leaf posts (posts that are not an ancestor of any other post). So A→B→C returns only C, not A or B.
    // O(leaves × max chain depth) in-memory; no extra DB queries or indexes needed.
    const idToPost = new Map(result.posts.map((p) => [p.id, p]));
    const strictAncestorIds = new Set<string>();
    for (const p of result.posts) {
      let currentId = p.parentId ?? null;
      while (currentId) {
        strictAncestorIds.add(currentId);
        const parentPost = idToPost.get(currentId);
        currentId = parentPost?.parentId ?? null;
      }
    }
    const filteredPosts = result.posts.filter((p) => !strictAncestorIds.has(p.id));

    // Collect full ancestor chain (walk parentId until null) and fetch all ancestors.
    const parentMap = new Map<string, (Awaited<ReturnType<typeof this.posts.getById>>)>();
    let toFetch = new Set<string>(filteredPosts.map((p) => p.parentId).filter(Boolean) as string[]);
    while (toFetch.size > 0) {
      const batch = [...toFetch].filter((id) => !parentMap.has(id));
      if (batch.length === 0) break;
      const results = await Promise.allSettled(
        batch.map((id) => this.posts.getById({ viewerUserId, id })),
      );
      const nextIds = new Set<string>();
      for (let i = 0; i < batch.length; i++) {
        const r = results[i];
        if (r?.status === 'fulfilled' && r.value) {
          const parent = r.value;
          parentMap.set(batch[i], parent);
          if (parent.parentId) nextIds.add(parent.parentId);
        }
      }
      toFetch = nextIds;
    }

    const allPostIds = [...filteredPosts.map((p) => p.id), ...parentMap.keys()];
    const boosted = viewerUserId
      ? await this.posts.viewerBoostedPostIds({
          viewerUserId,
          postIds: allPostIds,
        })
      : new Set<string>();
    const bookmarksByPostId = viewerUserId
      ? await this.posts.viewerBookmarksByPostId({ viewerUserId, postIds: allPostIds })
      : new Map<string, { collectionIds: string[] }>();
    const votedPollOptionIdByPostId = viewerUserId
      ? await this.posts.viewerVotedPollOptionIdByPostId({ viewerUserId, postIds: allPostIds })
      : new Map<string, string>();
    const internalByPostId = viewerHasAdmin ? await this.posts.ensureBoostScoresFresh(filteredPosts.map((p) => p.id)) : null;
    const scoreByPostId =
      viewerHasAdmin ? await this.posts.computeScoresForPostIds(allPostIds) : undefined;

    const baseUrl = this.appConfig.r2()?.publicBaseUrl ?? null;
    const attachParentChain = buildAttachParentChain({
      parentMap,
      baseUrl,
      boosted,
      bookmarksByPostId,
      votedPollOptionIdByPostId,
      viewerHasAdmin,
      internalByPostId,
      scoreByPostId,
      toPostDto,
    });

    setReadCache(httpRes, { viewerUserId });
    return {
      data: filteredPosts.map((p) => attachParentChain(p)),
      pagination: { nextCursor: result.nextCursor },
    };
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

    const result = await this.posts.listForUsername({
      viewerUserId,
      username,
      limit,
      cursor,
      visibility: parsed.visibility ?? 'all',
      includeCounts: parsed.includeCounts ?? true,
      sort: sortKind === 'popular' ? 'popular' : 'new',
    });

    const viewer = await this.posts.viewerContext(viewerUserId);
    const viewerHasAdmin = Boolean(viewer?.siteAdmin);
    // Dedupe: keep only leaf posts (same as list()). O(leaves × max chain depth) in-memory.
    const idToPostUser = new Map(result.posts.map((p) => [p.id, p]));
    const strictAncestorIdsUser = new Set<string>();
    for (const p of result.posts) {
      let currentId = p.parentId ?? null;
      while (currentId) {
        strictAncestorIdsUser.add(currentId);
        const parentPost = idToPostUser.get(currentId);
        currentId = parentPost?.parentId ?? null;
      }
    }
    const filteredPostsUser = result.posts.filter((p) => !strictAncestorIdsUser.has(p.id));

    // Collect full ancestor chain (walk parentId until null) and fetch all ancestors.
    const parentMap = new Map<string, (Awaited<ReturnType<typeof this.posts.getById>>)>();
    let toFetch = new Set<string>(filteredPostsUser.map((p) => p.parentId).filter(Boolean) as string[]);
    while (toFetch.size > 0) {
      const batch = [...toFetch].filter((id) => !parentMap.has(id));
      if (batch.length === 0) break;
      const results = await Promise.allSettled(
        batch.map((id) => this.posts.getById({ viewerUserId, id })),
      );
      const nextIds = new Set<string>();
      for (let i = 0; i < batch.length; i++) {
        const r = results[i];
        if (r?.status === 'fulfilled' && r.value) {
          const parent = r.value;
          parentMap.set(batch[i], parent);
          if (parent.parentId) nextIds.add(parent.parentId);
        }
      }
      toFetch = nextIds;
    }

    const allPostIds = [...filteredPostsUser.map((p) => p.id), ...parentMap.keys()];
    const boosted = viewerUserId
      ? await this.posts.viewerBoostedPostIds({
          viewerUserId,
          postIds: allPostIds,
        })
      : new Set<string>();
    const bookmarksByPostId = viewerUserId
      ? await this.posts.viewerBookmarksByPostId({ viewerUserId, postIds: allPostIds })
      : new Map<string, { collectionIds: string[] }>();
    const votedPollOptionIdByPostId = viewerUserId
      ? await this.posts.viewerVotedPollOptionIdByPostId({ viewerUserId, postIds: allPostIds })
      : new Map<string, string>();
    const internalByPostId = viewerHasAdmin ? await this.posts.ensureBoostScoresFresh(filteredPostsUser.map((p) => p.id)) : null;
    const scoreByPostIdUser =
      viewerHasAdmin ? await this.posts.computeScoresForPostIds(allPostIds) : undefined;

    const baseUrl = this.appConfig.r2()?.publicBaseUrl ?? null;
    const attachParentChain = buildAttachParentChain({
      parentMap,
      baseUrl,
      boosted,
      bookmarksByPostId,
      votedPollOptionIdByPostId,
      viewerHasAdmin,
      internalByPostId,
      scoreByPostId: scoreByPostIdUser,
      toPostDto,
    });

    setReadCache(httpRes, { viewerUserId });
    return {
      data: filteredPostsUser.map((p) => attachParentChain(p)),
      pagination: { nextCursor: result.nextCursor, counts: result.counts ?? null },
    };
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
      data: res.posts.map((p) =>
        toPostDto(p, this.appConfig.r2()?.publicBaseUrl ?? null, {
          viewerHasBoosted: false,
          includeInternal: viewerHasAdmin,
          internalOverride: (() => {
            const base = internalByPostId?.get(p.id);
            const score = scoreByPostIdOnlyMe?.get(p.id);
            return base || (typeof score === 'number' ? { score } : undefined)
              ? { ...base, ...(typeof score === 'number' ? { score } : {}) }
              : undefined;
          })(),
        }),
      ),
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
      data: result.comments.map((p) =>
        toPostDto(p, this.appConfig.r2()?.publicBaseUrl ?? null, {
          viewerHasBoosted: boosted.has(p.id),
          viewerHasBookmarked: bookmarksByPostId.has(p.id),
          viewerBookmarkCollectionIds: bookmarksByPostId.get(p.id)?.collectionIds ?? [],
          viewerVotedPollOptionId: votedPollOptionIdByPostId.get(p.id) ?? null,
          includeInternal: viewerHasAdmin,
          internalOverride: (() => {
            const base = internalByPostId?.get(p.id);
            const score = scoreByPostIdComments?.get(p.id);
            return base || (typeof score === 'number' ? { score } : undefined)
              ? { ...base, ...(typeof score === 'number' ? { score } : {}) }
              : undefined;
          })(),
        }),
      ),
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
    const post = await this.posts.getById({ viewerUserId, id });

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

    const postIds = chain.map((p) => p.id);
    const boosted = viewerUserId
      ? await this.posts.viewerBoostedPostIds({ viewerUserId, postIds })
      : new Set<string>();
    const bookmarksByPostId = viewerUserId
      ? await this.posts.viewerBookmarksByPostId({ viewerUserId, postIds })
      : new Map<string, { collectionIds: string[] }>();
    const votedPollOptionIdByPostId = viewerUserId
      ? await this.posts.viewerVotedPollOptionIdByPostId({ viewerUserId, postIds })
      : new Map<string, string>();
    const internalByPostId = viewerHasAdmin ? await this.posts.ensureBoostScoresFresh(postIds) : null;
    const scoreByPostIdGet =
      viewerHasAdmin ? await this.posts.computeScoresForPostIds(postIds) : undefined;

    const r2 = this.appConfig.r2()?.publicBaseUrl ?? null;
    const toDto = (p: (typeof chain)[number], opts: { parent?: ReturnType<typeof toPostDto> }) => {
      const base = internalByPostId?.get(p.id);
      const score = scoreByPostIdGet?.get(p.id);
      const dto = toPostDto(p, r2, {
        viewerHasBoosted: boosted.has(p.id),
        viewerHasBookmarked: bookmarksByPostId.has(p.id),
        viewerBookmarkCollectionIds: bookmarksByPostId.get(p.id)?.collectionIds ?? [],
        viewerVotedPollOptionId: votedPollOptionIdByPostId.get(p.id) ?? null,
        includeInternal: viewerHasAdmin,
        internalOverride:
          base || (typeof score === 'number' ? { score } : undefined)
            ? { ...base, ...(typeof score === 'number' ? { score } : {}) }
            : undefined,
      });
      return opts.parent ? { ...dto, parent: opts.parent } : dto;
    };

    // Build from root down: chain[chain.length-1] is root, chain[0] is leaf (the post we're viewing)
    let dto = toDto(chain[chain.length - 1], {});
    for (let i = chain.length - 2; i >= 0; i--) {
      dto = toDto(chain[i], { parent: dto });
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
    const created = await this.posts.createPost({
      userId,
      body: (parsed.body ?? '').trim(),
      visibility: parsed.visibility ?? 'public',
      parentId: parsed.parent_id ?? null,
      mentions: parsed.mentions ?? null,
      media,
      poll,
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
    const updated = await this.posts.updatePost({ userId, postId: id, body: (parsed.body ?? '').trim() });

    const viewer = await this.posts.viewerContext(userId);
    const viewerHasAdmin = Boolean(viewer?.siteAdmin);
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
}

