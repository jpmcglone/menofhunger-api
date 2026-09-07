import { Body, Controller, Delete, Get, Param, Post, Req, UseGuards } from '@nestjs/common';
import { Throttle } from '@nestjs/throttler';
import { z } from 'zod';
import { AdminGuard, type AdminRequest } from './admin.guard';
import { AvatarVideoService } from '../uploads/avatar-video.service';
import { AVATAR_VIDEO_MAX_DURATION_SECONDS, AVATAR_VIDEO_MAX_INPUT_BYTES, avatarVideoSelectionSchema } from '../uploads/avatar-video-policy';

@UseGuards(AdminGuard)
@Controller('admin/users/:userId/uploads/avatar/video')
export class AdminAvatarVideoController {
  constructor(private readonly videos: AvatarVideoService) {}

  @Get('capabilities')
  async capabilities(@Req() request: AdminRequest, @Param('userId') userId: string) {
    return { data: { canSet: await this.videos.canSet(userId, null, request.user!.id),
      maxBytes: AVATAR_VIDEO_MAX_INPUT_BYTES, maxDurationSeconds: AVATAR_VIDEO_MAX_DURATION_SECONDS } };
  }

  @Post('init')
  @Throttle({ default: { limit: 10, ttl: 60_000 } })
  async init(@Req() request: AdminRequest, @Param('userId') userId: string, @Body() body: unknown) {
    const { contentType } = z.object({ contentType: z.string() }).parse(body);
    return { data: await this.videos.init(userId, null, contentType, request.user!.id) };
  }

  @Post(':id/commit')
  @Throttle({ default: { limit: 10, ttl: 60_000 } })
  async commit(@Req() request: AdminRequest, @Param('userId') userId: string, @Param('id') id: string, @Body() body: unknown) {
    return { data: await this.videos.commit(userId, null, id, avatarVideoSelectionSchema.parse(body), request.user!.id) };
  }

  @Get(':id')
  async status(@Param('userId') userId: string, @Param('id') id: string) {
    return { data: await this.videos.status(userId, id) };
  }

  @Delete(':id')
  async cancel(@Param('userId') userId: string, @Param('id') id: string) {
    return { data: await this.videos.cancel(userId, id) };
  }
}
