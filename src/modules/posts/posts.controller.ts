import { Body, Controller, Delete, Get, Param, Post, Query, Req, UseGuards } from '@nestjs/common';
import { z } from 'zod';
import type { Request } from 'express';
import { AuthGuard } from '../auth/auth.guard';
import { OptionalAuthGuard } from '../auth/optional-auth.guard';
import { AppConfigService } from '../app/app-config.service';
import { CurrentUserId } from '../users/users.decorator';
import { PostsService } from './posts.service';
import { toPostDto } from './post.dto';

const listSchema = z.object({
  limit: z.coerce.number().int().min(1).max(50).optional(),
  cursor: z.string().optional(),
  visibility: z.enum(['all', 'public', 'verifiedOnly', 'premiumOnly']).optional(),
  followingOnly: z.coerce.boolean().optional(),
});

const userListSchema = listSchema.extend({
  visibility: z.enum(['all', 'public', 'verifiedOnly', 'premiumOnly']).optional(),
  includeCounts: z.coerce.boolean().optional(),
});

const createSchema = z.object({
  body: z.string().trim().min(1).max(500),
  visibility: z.enum(['public', 'verifiedOnly', 'premiumOnly', 'onlyMe']).optional(),
});

@Controller('posts')
export class PostsController {
  constructor(
    private readonly posts: PostsService,
    private readonly appConfig: AppConfigService,
  ) {}

  @UseGuards(OptionalAuthGuard)
  @Get()
  async list(@Req() req: Request, @Query() query: unknown) {
    const parsed = listSchema.parse(query);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const viewerUserId = ((req as any).user?.id as string | undefined) ?? null;
    const limit = parsed.limit ?? 30;
    const cursor = parsed.cursor ?? null;

    const res = await this.posts.listFeed({
      viewerUserId,
      limit,
      cursor,
      visibility: parsed.visibility ?? 'all',
      followingOnly: parsed.followingOnly ?? false,
    });

    return {
      posts: res.posts.map((p) => toPostDto(p, this.appConfig.r2()?.publicBaseUrl ?? null)),
      nextCursor: res.nextCursor,
    };
  }

  @UseGuards(OptionalAuthGuard)
  @Get('user/:username')
  async listForUser(@Req() req: Request, @Param('username') username: string, @Query() query: unknown) {
    const parsed = userListSchema.parse(query);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const viewerUserId = ((req as any).user?.id as string | undefined) ?? null;
    const limit = parsed.limit ?? 30;
    const cursor = parsed.cursor ?? null;

    const res = await this.posts.listForUsername({
      viewerUserId,
      username,
      limit,
      cursor,
      visibility: parsed.visibility ?? 'all',
      includeCounts: parsed.includeCounts ?? true,
    });

    return {
      posts: res.posts.map((p) => toPostDto(p, this.appConfig.r2()?.publicBaseUrl ?? null)),
      nextCursor: res.nextCursor,
      counts: res.counts ?? null,
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
    return {
      posts: res.posts.map((p) => toPostDto(p, this.appConfig.r2()?.publicBaseUrl ?? null)),
      nextCursor: res.nextCursor,
    };
  }

  @UseGuards(OptionalAuthGuard)
  @Get(':id')
  async getById(@Req() req: Request, @Param('id') id: string) {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const viewerUserId = ((req as any).user?.id as string | undefined) ?? null;
    const res = await this.posts.getById({ viewerUserId, id });
    return { post: toPostDto(res, this.appConfig.r2()?.publicBaseUrl ?? null) };
  }

  @UseGuards(AuthGuard)
  @Post()
  async create(@Body() body: unknown, @CurrentUserId() userId: string) {
    const parsed = createSchema.parse(body);
    const created = await this.posts.createPost({
      userId,
      body: parsed.body,
      visibility: parsed.visibility ?? 'public',
    });

    return { post: toPostDto(created, this.appConfig.r2()?.publicBaseUrl ?? null) };
  }

  @UseGuards(AuthGuard)
  @Delete(':id')
  async delete(@Param('id') id: string, @CurrentUserId() userId: string) {
    return await this.posts.deletePost({ userId, postId: id });
  }
}

