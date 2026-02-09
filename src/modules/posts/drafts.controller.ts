import { Body, Controller, Delete, Get, Param, Patch, Post, Query, UseGuards } from '@nestjs/common';
import { Throttle } from '@nestjs/throttler';
import { z } from 'zod';
import { AuthGuard } from '../auth/auth.guard';
import { AppConfigService } from '../app/app-config.service';
import { CurrentUserId } from '../users/users.decorator';
import { rateLimitLimit, rateLimitTtl } from '../../common/throttling/rate-limit.resolver';
import { PostsService } from './posts.service';
import { toPostDto } from './post.dto';

const draftMediaUploadSchema = z.object({
  source: z.literal('upload'),
  kind: z.enum(['image', 'gif', 'video']),
  r2Key: z.string().min(1),
  thumbnailR2Key: z.string().min(1).optional(),
  width: z.coerce.number().int().min(1).max(20000).optional(),
  height: z.coerce.number().int().min(1).max(20000).optional(),
  durationSeconds: z.coerce.number().int().min(0).max(3600).optional(),
  alt: z.string().trim().max(500).nullish(),
});

const draftMediaSchema = z.discriminatedUnion('source', [
  draftMediaUploadSchema,
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

type DraftMediaItem = z.infer<typeof draftMediaSchema>;

const listSchema = z.object({
  limit: z.coerce.number().int().min(1).max(50).optional(),
  cursor: z.string().optional(),
});

const createSchema = z.object({
  body: z.string().trim().max(500).optional(),
  media: z.array(draftMediaSchema).max(4).optional(),
});

const patchSchema = z.object({
  body: z.string().trim().max(500).optional(),
  media: z.array(draftMediaSchema).max(4).optional(),
});

@UseGuards(AuthGuard)
@Controller('drafts')
export class DraftsController {
  constructor(
    private readonly posts: PostsService,
    private readonly appConfig: AppConfigService,
  ) {}

  @Throttle({
    default: {
      limit: rateLimitLimit('interact', 180),
      ttl: rateLimitTtl('interact', 60),
    },
  })
  @Get()
  async list(@CurrentUserId() userId: string, @Query() query: unknown) {
    const parsed = listSchema.parse(query);
    const limit = parsed.limit ?? 30;
    const cursor = parsed.cursor ?? null;
    const res = await this.posts.listDrafts({ userId, limit, cursor });
    const viewer = await this.posts.viewerContext(userId);
    const viewerHasAdmin = Boolean(viewer?.siteAdmin);
    return {
      data: res.posts.map((p) =>
        toPostDto(p, this.appConfig.r2()?.publicBaseUrl ?? null, {
          viewerHasBoosted: false,
          includeInternal: viewerHasAdmin,
        }),
      ),
      pagination: { nextCursor: res.nextCursor },
    };
  }

  @Throttle({
    default: {
      limit: rateLimitLimit('interact', 180),
      ttl: rateLimitTtl('interact', 60),
    },
  })
  @Post()
  async create(@CurrentUserId() userId: string, @Body() body: unknown) {
    const parsed = createSchema.parse(body);
    const media = (parsed.media ?? null) as DraftMediaItem[] | null;
    const created = await this.posts.createDraft({
      userId,
      body: (parsed.body ?? '').trim(),
      media,
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

  @Throttle({
    default: {
      limit: rateLimitLimit('interact', 180),
      ttl: rateLimitTtl('interact', 60),
    },
  })
  @Patch(':id')
  async patch(@CurrentUserId() userId: string, @Param('id') id: string, @Body() body: unknown) {
    const parsed = patchSchema.parse(body);
    const media = (parsed.media ?? null) as DraftMediaItem[] | null;
    const updated = await this.posts.updateDraft({
      userId,
      draftId: id,
      body: typeof parsed.body === 'string' ? parsed.body.trim() : undefined,
      media,
    });
    const viewer = await this.posts.viewerContext(userId);
    const viewerHasAdmin = Boolean(viewer?.siteAdmin);
    return {
      data: toPostDto(updated, this.appConfig.r2()?.publicBaseUrl ?? null, {
        viewerHasBoosted: false,
        includeInternal: viewerHasAdmin,
      }),
    };
  }

  @Throttle({
    default: {
      limit: rateLimitLimit('interact', 180),
      ttl: rateLimitTtl('interact', 60),
    },
  })
  @Delete(':id')
  async delete(@CurrentUserId() userId: string, @Param('id') id: string) {
    const result = await this.posts.deleteDraft({ userId, draftId: id });
    return { data: result };
  }
}

