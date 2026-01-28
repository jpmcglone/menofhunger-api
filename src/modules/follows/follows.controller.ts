import { Controller, Delete, Get, Param, Post, Query, Req, UseGuards } from '@nestjs/common';
import type { Request } from 'express';
import { z } from 'zod';
import { AuthGuard } from '../auth/auth.guard';
import { OptionalAuthGuard } from '../auth/optional-auth.guard';
import { CurrentUserId } from '../users/users.decorator';
import { FollowsService } from './follows.service';

const listSchema = z.object({
  limit: z.coerce.number().int().min(1).max(50).optional(),
  cursor: z.string().optional(),
});

@Controller('follows')
export class FollowsController {
  constructor(private readonly follows: FollowsService) {}

  @UseGuards(AuthGuard)
  @Post(':username')
  async follow(@Param('username') username: string, @CurrentUserId() viewerUserId: string) {
    return await this.follows.follow({ viewerUserId, username });
  }

  @UseGuards(AuthGuard)
  @Delete(':username')
  async unfollow(@Param('username') username: string, @CurrentUserId() viewerUserId: string) {
    return await this.follows.unfollow({ viewerUserId, username });
  }

  @UseGuards(OptionalAuthGuard)
  @Get('status/:username')
  async status(@Req() req: Request, @Param('username') username: string) {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const viewerUserId = ((req as any).user?.id as string | undefined) ?? null;
    return await this.follows.status({ viewerUserId, username });
  }

  @UseGuards(OptionalAuthGuard)
  @Get('summary/:username')
  async summary(@Req() req: Request, @Param('username') username: string) {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const viewerUserId = ((req as any).user?.id as string | undefined) ?? null;
    return await this.follows.summary({ viewerUserId, username });
  }

  @UseGuards(OptionalAuthGuard)
  @Get(':username/followers')
  async followers(@Req() req: Request, @Param('username') username: string, @Query() query: unknown) {
    const parsed = listSchema.parse(query);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const viewerUserId = ((req as any).user?.id as string | undefined) ?? null;
    const limit = parsed.limit ?? 30;
    const cursor = parsed.cursor ?? null;
    return await this.follows.listFollowers({ viewerUserId, username, limit, cursor });
  }

  @UseGuards(OptionalAuthGuard)
  @Get(':username/following')
  async following(@Req() req: Request, @Param('username') username: string, @Query() query: unknown) {
    const parsed = listSchema.parse(query);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const viewerUserId = ((req as any).user?.id as string | undefined) ?? null;
    const limit = parsed.limit ?? 30;
    const cursor = parsed.cursor ?? null;
    return await this.follows.listFollowing({ viewerUserId, username, limit, cursor });
  }
}

