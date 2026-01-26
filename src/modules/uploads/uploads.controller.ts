import { Body, Controller, Post, UseGuards } from '@nestjs/common';
import { z } from 'zod';
import { AuthGuard } from '../auth/auth.guard';
import { CurrentUserId } from '../users/users.decorator';
import { UploadsService } from './uploads.service';

const initAvatarSchema = z.object({
  contentType: z.string().min(1),
});

const commitAvatarSchema = z.object({
  key: z.string().min(1),
});

@UseGuards(AuthGuard)
@Controller('uploads')
export class UploadsController {
  constructor(private readonly uploads: UploadsService) {}

  @Post('avatar/init')
  async initAvatar(@Body() body: unknown, @CurrentUserId() userId: string) {
    const parsed = initAvatarSchema.parse(body);
    return await this.uploads.initAvatarUpload(userId, parsed.contentType);
  }

  @Post('avatar/commit')
  async commitAvatar(@Body() body: unknown, @CurrentUserId() userId: string) {
    const parsed = commitAvatarSchema.parse(body);
    return await this.uploads.commitAvatarUpload(userId, parsed.key);
  }
}

