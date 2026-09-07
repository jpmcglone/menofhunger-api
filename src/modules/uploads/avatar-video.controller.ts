import { Body, Controller, Delete, Get, Param, Post, Req, UseGuards } from '@nestjs/common';
import { Throttle } from '@nestjs/throttler';
import { z } from 'zod';
import { AuthGuard, type AuthedRequest } from '../auth/auth.guard';
import { AvatarVideoService } from './avatar-video.service';
import { AVATAR_VIDEO_MAX_DURATION_SECONDS, AVATAR_VIDEO_MAX_INPUT_BYTES, avatarVideoSelectionSchema } from './avatar-video-policy';

@UseGuards(AuthGuard)
@Controller('uploads/avatar/video')
export class AvatarVideoController {
  constructor(private readonly videos: AvatarVideoService) {}

  @Get('capabilities')
  async capabilities(@Req() request: AuthedRequest) {
    return { data: { canSet: await this.videos.canSet(request.user!.id, request.user!.operatedByUserId), maxBytes: AVATAR_VIDEO_MAX_DURATION_SECONDS, AVATAR_VIDEO_MAX_INPUT_BYTES, maxDurationSeconds: AVATAR_VIDEO_MAX_DURATION_SECONDS } };
  }

  @Post('init')
  @Throttle({ default: { limit: 10, ttl: 60_000 } })
  async init(@Req() request: AuthedRequest, @Body() body: unknown) {
    const { contentType } = z.object({ contentType: z.string() }).parse(body);
    return { data: await this.videos.init(request.user!.id, request.user!.operatedByUserId ?? null, contentType) };
  }

  @Post(':id/commit')
  @Throttle({ default: { limit: 10, ttl: 60_000 } })
  async commit(@Req() request: AuthedRequest, @Param('id') id: string, @Body() body: unknown) {
    return { data: await this.videos.commit(request.user!.id, request.user!.operatedByUserId ?? null, id, avatarVideoSelectionSchema.parse(body)) };
  }

  @Get(':id')
  async status(@Req() request: AuthedRequest, @Param('id') id: string) {
    return { data: await this.videos.status(request.user!.id, id) };
  }

  @Delete(':id')
  async cancel(@Req() request: AuthedRequest, @Param('id') id: string) {
    return { data: await this.videos.cancel(request.user!.id, id) };
  }
}
