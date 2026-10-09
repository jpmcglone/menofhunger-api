import { Body, Controller, Delete, Get, Param, Patch, Post, Query, UseGuards } from '@nestjs/common';
import { AuthGuard } from '../auth/auth-public-api';
import { CurrentUserId } from '../users/users.decorator';
import { ScheduledPostsService } from './scheduled-posts.service';
import type { PostVisibility } from '@prisma/client';
import { createSchema, updateSchema, listSchema } from './scheduled-posts.schemas';

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
      crosspost: parsed.crosspost,
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
      crosspost: parsed.crosspost,
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
