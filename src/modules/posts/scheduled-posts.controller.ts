import { Body, Controller, Delete, Get, Param, Patch, Post, Query, UseGuards } from '@nestjs/common';
import { z } from 'zod';
import { AuthGuard } from '../auth/auth.guard';
import { CurrentUserId } from '../users/users.decorator';
import { ScheduledPostsService } from './scheduled-posts.service';
import type { PostVisibility } from '@prisma/client';

const mediaUploadSchema = z.object({
  source: z.literal('upload'),
  kind: z.enum(['image', 'gif', 'video']),
  r2Key: z.string().min(1),
  thumbnailR2Key: z.string().min(1).optional(),
  width: z.coerce.number().int().min(1).max(20000).optional(),
  height: z.coerce.number().int().min(1).max(20000).optional(),
  durationSeconds: z.coerce.number().int().min(0).max(3600).optional(),
  alt: z.string().trim().max(500).nullish(),
});

const mediaGiphySchema = z.object({
  source: z.literal('giphy'),
  kind: z.literal('gif'),
  url: z.string().url(),
  mp4Url: z.string().url().optional(),
  width: z.coerce.number().int().min(1).max(20000).optional(),
  height: z.coerce.number().int().min(1).max(20000).optional(),
  alt: z.string().trim().max(500).nullish(),
});

const mediaExistingSchema = z.object({
  source: z.literal('existing'),
  id: z.string().min(1),
  alt: z.string().trim().max(500).nullish(),
});

// Create only accepts upload + giphy (new media).
const mediaCreateSchema = z.discriminatedUnion('source', [mediaUploadSchema, mediaGiphySchema]);
// Update also accepts 'existing' references (unchanged media from the holding row).
const mediaUpdateSchema = z.discriminatedUnion('source', [mediaExistingSchema, mediaUploadSchema, mediaGiphySchema]);

const pollOptionSchema = z.object({ text: z.string().trim().min(1).max(80) });

const pollSchema = z.object({
  options: z.array(pollOptionSchema).min(2).max(4),
  durationHours: z.number().int().min(1).max(168),
});

const createSchema = z.object({
  body: z.string().trim().max(1000).default(''),
  visibility: z.enum(['public', 'verifiedOnly', 'premiumOnly']),
  scheduled_at: z
    .string()
    .datetime()
    .transform((v) => new Date(v)),
  media: z.array(mediaCreateSchema).max(4).optional(),
  poll: pollSchema.nullish(),
  community_group_id: z.string().trim().nullish(),
});

const updateSchema = z.object({
  body: z.string().trim().max(1000).optional(),
  visibility: z.enum(['public', 'verifiedOnly', 'premiumOnly']).optional(),
  scheduled_at: z
    .string()
    .datetime()
    .transform((v) => new Date(v))
    .optional(),
  media: z.array(mediaUpdateSchema).max(4).nullish(),
  poll: pollSchema.nullish(),
  community_group_id: z.string().trim().nullish(),
});

const listSchema = z.object({
  limit: z.coerce.number().int().min(1).max(50).optional(),
  cursor: z.string().optional(),
});

@UseGuards(AuthGuard)
@Controller('posts/scheduled')
export class ScheduledPostsController {
  constructor(private readonly scheduledPosts: ScheduledPostsService) {}

  @Post()
  async create(@Body() body: unknown, @CurrentUserId() userId: string) {
    const parsed = createSchema.parse(body);
    const item = await this.scheduledPosts.createScheduled({
      userId,
      body: parsed.body,
      visibility: parsed.visibility as PostVisibility,
      scheduledAt: parsed.scheduled_at,
      media: parsed.media?.map((m) => ({
        source: m.source,
        kind: m.kind,
        r2Key: 'r2Key' in m ? m.r2Key : undefined,
        thumbnailR2Key: 'thumbnailR2Key' in m ? m.thumbnailR2Key : undefined,
        url: 'url' in m ? m.url : undefined,
        mp4Url: 'mp4Url' in m ? m.mp4Url : undefined,
        width: m.width ?? undefined,
        height: m.height ?? undefined,
        durationSeconds: 'durationSeconds' in m ? m.durationSeconds : undefined,
        alt: m.alt ?? null,
      })) ?? null,
      poll: parsed.poll
        ? {
            options: parsed.poll.options.map((o) => ({ text: o.text })),
            durationHours: parsed.poll.durationHours,
          }
        : null,
      communityGroupId: parsed.community_group_id ?? null,
    });
    return { data: item };
  }

  @Get()
  async list(@Query() query: unknown, @CurrentUserId() userId: string) {
    const parsed = listSchema.parse(query);
    const result = await this.scheduledPosts.listScheduled({
      userId,
      cursor: parsed.cursor ?? null,
      limit: parsed.limit,
    });
    return { data: result.items, pagination: { nextCursor: result.nextCursor } };
  }

  @Patch(':id')
  async update(@Param('id') id: string, @Body() body: unknown, @CurrentUserId() userId: string) {
    const parsed = updateSchema.parse(body);
    const item = await this.scheduledPosts.updateScheduled({
      userId,
      scheduledPostId: id,
      body: parsed.body,
      visibility: parsed.visibility as PostVisibility | undefined,
      scheduledAt: parsed.scheduled_at,
      media:
        parsed.media === undefined
          ? undefined
          : parsed.media
            ? parsed.media.map((m) => {
                if (m.source === 'existing') {
                  return { source: 'existing' as const, id: m.id, alt: m.alt ?? null };
                }
                return {
                  source: m.source,
                  kind: m.kind,
                  r2Key: 'r2Key' in m ? m.r2Key : undefined,
                  thumbnailR2Key: 'thumbnailR2Key' in m ? m.thumbnailR2Key : undefined,
                  url: 'url' in m ? m.url : undefined,
                  mp4Url: 'mp4Url' in m ? m.mp4Url : undefined,
                  width: m.width ?? undefined,
                  height: m.height ?? undefined,
                  durationSeconds: 'durationSeconds' in m ? m.durationSeconds : undefined,
                  alt: m.alt ?? null,
                };
              })
            : [],
      poll:
        parsed.poll === undefined
          ? undefined
          : parsed.poll
            ? {
                options: parsed.poll.options.map((o) => ({ text: o.text })),
                durationHours: parsed.poll.durationHours,
              }
            : null,
      communityGroupId: parsed.community_group_id === undefined ? undefined : (parsed.community_group_id ?? null),
    });
    return { data: item };
  }

  @Delete(':id')
  async delete(@Param('id') id: string, @CurrentUserId() userId: string) {
    const result = await this.scheduledPosts.deleteScheduled({ userId, scheduledPostId: id });
    return { data: result };
  }
}
