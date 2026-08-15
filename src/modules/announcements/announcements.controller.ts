import { Body, Controller, Get, Param, Post, Query, UseGuards } from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import { z } from 'zod';
import { OptionalAuthGuard } from '../auth/optional-auth.guard';
import { OptionalCurrentUserId } from '../users/users.decorator';
import { AnnouncementsService } from './announcements.service';

const platformSchema = z.enum(['web', 'ios']);
const anonymousIdSchema = z.string().trim().min(12).max(128).optional();

const pendingQuerySchema = z.object({
  platform: platformSchema,
  anonymousId: anonymousIdSchema,
});

const eventBodySchema = z.object({
  type: z.enum(['presented', 'viewed', 'dismissed', 'clicked', 'abandoned']),
  platform: platformSchema,
  anonymousId: anonymousIdSchema,
  dismissMethod: z.enum(['close_button', 'backdrop', 'escape', 'swipe']).optional().nullable(),
});

@ApiTags('Announcements')
@UseGuards(OptionalAuthGuard)
@Controller('announcements')
export class AnnouncementsController {
  constructor(private readonly announcements: AnnouncementsService) {}

  @ApiOperation({ summary: 'Next unseen announcement or due ad for this session start' })
  @Get('pending')
  async pending(@Query() query: unknown, @OptionalCurrentUserId() userId?: string) {
    const parsed = pendingQuerySchema.parse(query);
    const data = await this.announcements.getPending({
      userId: userId ?? null,
      anonymousId: parsed.anonymousId ?? null,
      platform: parsed.platform,
    });
    return { data };
  }

  @ApiOperation({ summary: 'Record a present / view / dismiss / click / abandon event' })
  @Post(':id/events')
  async recordEvent(
    @Param('id') id: string,
    @Body() body: unknown,
    @OptionalCurrentUserId() userId?: string,
  ) {
    const parsed = eventBodySchema.parse(body);
    const data = await this.announcements.recordEvent({
      announcementId: id,
      userId: userId ?? null,
      anonymousId: parsed.anonymousId ?? null,
      platform: parsed.platform,
      type: parsed.type,
      dismissMethod: parsed.dismissMethod ?? null,
    });
    return { data };
  }
}
