import { limitQuery } from '../../common/pagination/cursor-query.schema';
import { Body, Controller, Delete, Get, Param, Patch, Post, Query, Res, UseGuards } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import { Throttle } from '@nestjs/throttler';
import type { Response } from 'express';
import { z } from 'zod';
import { AuthGuard } from '../auth/auth-public-api';
import { OptionalAuthGuard } from '../auth/auth-public-api';
import { CurrentUserId, OptionalCurrentUserId } from '../users/users.decorator';
import { rateLimitLimit, rateLimitTtl } from '../../common/throttling/rate-limit.resolver';
import { setReadCache } from '../../common/http-cache';
import { BoardService } from './board.service';
import { PickaxCrosspostService } from '../pickax/pickax-crosspost.service';
import { XCrosspostService } from '../x/x-crosspost.service';
import {
  listSchema,
  commentsListSchema,
  createThreadSchema,
  updateThreadSchema,
  createCommentSchema,
  preferencesSchema,
} from './board.schemas';

const interactThrottle = { default: { limit: rateLimitLimit('interact', 180), ttl: rateLimitTtl('interact', 60) } };
const createThrottle = { default: { limit: rateLimitLimit('postCreate', 30), ttl: rateLimitTtl('postCreate', 60) } };

@ApiTags('Board')
@Controller('board')
export class BoardController {
  constructor(
    private readonly board: BoardService,
    private readonly pickax: PickaxCrosspostService,
    private readonly x: XCrosspostService,
  ) {}

  @UseGuards(OptionalAuthGuard)
  @Get('threads')
  async listThreads(
    @OptionalCurrentUserId() userId: string | undefined,
    @Query() query: unknown,
    @Res({ passthrough: true }) res: Response,
  ) {
    const parsed = listSchema.parse(query);
    const viewerUserId = userId ?? null;
    const q = parsed.q?.trim() || null;
    const result = await this.board.listThreads({
      viewerUserId,
      sort: parsed.sort ?? 'new',
      range: parsed.range ?? null,
      visibility: parsed.visibility ?? 'all',
      tags: parsed.tags,
      domain: parsed.domain?.trim() || null,
      q,
      authorUsername: parsed.author?.trim() || null,
      hiddenOnly: parsed.hidden === 'only',
      limit: parsed.limit ?? 30,
      cursor: parsed.cursor ?? null,
    });
    setReadCache(res, { viewerUserId });
    return { data: result.threads, pagination: { nextCursor: result.nextCursor } };
  }

  @UseGuards(OptionalAuthGuard)
  @Get('leaderboard')
  async leaderboard(@OptionalCurrentUserId() userId: string | undefined, @Query() query: unknown) {
    const parsed = z.object({ limit: limitQuery(50) }).parse(query);
    return { data: await this.board.leaderboard(userId ?? null, parsed.limit ?? 25) };
  }

  @UseGuards(OptionalAuthGuard)
  @Get('threads/:id')
  async getThread(
    @OptionalCurrentUserId() userId: string | undefined,
    @Param('id') id: string,
    @Res({ passthrough: true }) res: Response,
  ) {
    const viewerUserId = userId ?? null;
    const data = await this.board.getThread(viewerUserId, id);
    setReadCache(res, { viewerUserId });
    return { data };
  }

  @UseGuards(OptionalAuthGuard)
  @Get('threads/:id/comments')
  async listComments(
    @OptionalCurrentUserId() userId: string | undefined,
    @Param('id') id: string,
    @Query('sort') sort: string | undefined,
    @Res({ passthrough: true }) res: Response,
  ) {
    const viewerUserId = userId ?? null;
    const data = await this.board.listComments(viewerUserId, id, sort === 'new' ? 'new' : 'top');
    setReadCache(res, { viewerUserId });
    return { data };
  }

  @UseGuards(OptionalAuthGuard)
  @Get('comments')
  async listLatestComments(
    @OptionalCurrentUserId() userId: string | undefined,
    @Query() query: unknown,
    @Res({ passthrough: true }) res: Response,
  ) {
    const parsed = commentsListSchema.parse(query);
    const viewerUserId = userId ?? null;
    const result = await this.board.listLatestComments({
      viewerUserId,
      authorUsername: parsed.author?.trim() || null,
      limit: parsed.limit ?? 30,
      cursor: parsed.cursor ?? null,
    });
    setReadCache(res, { viewerUserId });
    return { data: result.comments, pagination: { nextCursor: result.nextCursor } };
  }

  @UseGuards(OptionalAuthGuard)
  @Get('comments/:id')
  async getComment(
    @OptionalCurrentUserId() userId: string | undefined,
    @Param('id') id: string,
    @Res({ passthrough: true }) res: Response,
  ) {
    const viewerUserId = userId ?? null;
    const data = await this.board.getCommentContext(viewerUserId, id);
    setReadCache(res, { viewerUserId });
    return { data };
  }

  @UseGuards(OptionalAuthGuard)
  @Get('tags')
  async listTags(@Query('q') q: string | undefined, @Query('limit') limit: string | undefined) {
    const data = await this.board.listTags(q ?? null, Number(limit) || 12);
    return { data };
  }

  @UseGuards(OptionalAuthGuard)
  @Get('duplicate')
  async findDuplicate(@OptionalCurrentUserId() userId: string | undefined, @Query('url') url: string | undefined) {
    const data = await this.board.findDuplicate(userId ?? null, url ?? '');
    return { data };
  }

  @UseGuards(AuthGuard)
  @Get('preferences')
  async getPreferences(@CurrentUserId() userId: string) {
    return { data: await this.board.getPreferences(userId) };
  }

  @UseGuards(AuthGuard)
  @Throttle(interactThrottle)
  @Patch('preferences')
  async updatePreferences(@CurrentUserId() userId: string, @Body() body: unknown) {
    const parsed = preferencesSchema.parse(body);
    return { data: await this.board.updatePreferences(userId, parsed) };
  }

  @UseGuards(AuthGuard)
  @Throttle(createThrottle)
  @Post('threads')
  async createThread(@CurrentUserId() userId: string, @Body() body: unknown) {
    const parsed = createThreadSchema.parse(body);
    const data = await this.board.createThread(userId, {
      title: parsed.title,
      url: parsed.url ?? null,
      body: parsed.body ?? null,
      image: parsed.image
        ? { r2Key: parsed.image.r2Key, width: parsed.image.width ?? null, height: parsed.image.height ?? null, alt: parsed.image.alt ?? null }
        : null,
      tags: parsed.tags ?? [],
      visibility: parsed.visibility ?? 'public',
      showInFeed: parsed.showInFeed ?? false,
    });
    const shareOutward = Boolean(parsed.showInFeed) && (parsed.visibility ?? 'public') === 'public';
    const pickax = shareOutward && parsed.crosspost?.pickax ? await this.pickax.requestPostCrosspost(userId, data.id, 'link') : null;
    const x = shareOutward && parsed.crosspost?.x ? await this.x.requestPostCrosspost(userId, data.id, 'link') : null;
    return { data, crossposts: { pickax, x } };
  }

  @UseGuards(AuthGuard)
  @Throttle(interactThrottle)
  @Patch('threads/:id')
  async updateThread(@CurrentUserId() userId: string, @Param('id') id: string, @Body() body: unknown) {
    const parsed = updateThreadSchema.parse(body);
    return { data: await this.board.updateThread(userId, id, parsed) };
  }

  @UseGuards(AuthGuard)
  @Throttle(interactThrottle)
  @Delete('threads/:id')
  async deleteThread(@CurrentUserId() userId: string, @Param('id') id: string) {
    return { data: await this.board.deletePost(userId, id) };
  }

  @UseGuards(AuthGuard)
  @Throttle(createThrottle)
  @Post('threads/:id/comments')
  async createComment(@CurrentUserId() userId: string, @Param('id') id: string, @Body() body: unknown) {
    const parsed = createCommentSchema.parse(body);
    return { data: await this.board.createComment(userId, id, { body: parsed.body, parentId: parsed.parentId ?? null }) };
  }

  @UseGuards(AuthGuard)
  @Throttle(interactThrottle)
  @Delete('comments/:id')
  async deleteComment(@CurrentUserId() userId: string, @Param('id') id: string) {
    return { data: await this.board.deletePost(userId, id) };
  }

  @UseGuards(AuthGuard)
  @Throttle(interactThrottle)
  @Post('threads/:id/hide')
  async hide(@CurrentUserId() userId: string, @Param('id') id: string) {
    return { data: await this.board.setHidden(userId, id, true) };
  }

  @UseGuards(AuthGuard)
  @Throttle(interactThrottle)
  @Delete('threads/:id/hide')
  async unhide(@CurrentUserId() userId: string, @Param('id') id: string) {
    return { data: await this.board.setHidden(userId, id, false) };
  }
}
