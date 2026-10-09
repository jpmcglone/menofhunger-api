import { Inject } from '@nestjs/common';
import { PostsDraftsService } from './posts-drafts.service';
import { PostsViewerEnrichmentService } from './posts-viewer-enrichment.service';
import { Body, Controller, Delete, Get, Param, Patch, Post, Query, UseGuards } from '@nestjs/common';
import { Throttle } from '@nestjs/throttler';
import { z } from 'zod';
import { AuthGuard } from '../auth/auth-public-api';
import { AppConfigService } from '../app/app-config.service';
import { CurrentUserId } from '../users/users.decorator';
import { rateLimitLimit, rateLimitTtl } from '../../common/throttling/rate-limit.resolver';

import { toPostDto } from './post.dto';
import { draftMediaSchema, listSchema, createSchema, patchSchema } from './drafts.schemas';

type DraftMediaItem = z.infer<typeof draftMediaSchema>;

@UseGuards(AuthGuard)
@Controller('drafts')
export class DraftsController {
  constructor(
    @Inject(PostsDraftsService) private readonly postsDrafts: Pick<PostsDraftsService, 'listDrafts' | 'createDraft' | 'updateDraft' | 'deleteDraft'>,
    @Inject(PostsViewerEnrichmentService) private readonly postsEnrichment: Pick<PostsViewerEnrichmentService, 'viewerContext'>,
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
    const res = await this.postsDrafts.listDrafts({ userId, limit, cursor });
    const viewer = await this.postsEnrichment.viewerContext(userId);
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
    const created = await this.postsDrafts.createDraft({
      userId,
      body: (parsed.body ?? '').trim(),
      media,
    });
    const viewer = await this.postsEnrichment.viewerContext(userId);
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
    const updated = await this.postsDrafts.updateDraft({
      userId,
      draftId: id,
      body: typeof parsed.body === 'string' ? parsed.body.trim() : undefined,
      media,
    });
    const viewer = await this.postsEnrichment.viewerContext(userId);
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
    const result = await this.postsDrafts.deleteDraft({ userId, draftId: id });
    return { data: result };
  }
}

