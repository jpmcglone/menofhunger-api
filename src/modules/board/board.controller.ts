import { Body, Controller, Delete, Get, Param, Patch, Post, Query, Res, UseGuards } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import { Throttle } from '@nestjs/throttler';
import type { Response } from 'express';
import { z } from 'zod';
import { AuthGuard } from '../auth/auth.guard';
import { OptionalAuthGuard } from '../auth/optional-auth.guard';
import { CurrentUserId, OptionalCurrentUserId } from '../users/users.decorator';
import { rateLimitLimit, rateLimitTtl } from '../../common/throttling/rate-limit.resolver';
import { setReadCache } from '../../common/http-cache';
import { BoardService } from './board.service';
import { BOARD_MAX_TAGS, BOARD_TITLE_MAX } from './board.utils';

const visibilitySchema = z.enum(['public', 'verifiedOnly', 'premiumOnly']);

const tagsQuerySchema = z
  .union([z.string(), z.array(z.string())])
  .optional()
  .transform((v) => (Array.isArray(v) ? v : (v ?? '').split(',')).map((t) => t.trim()).filter(Boolean).slice(0, BOARD_MAX_TAGS));

const listSchema = z.object({
  sort: z.enum(['top', 'new']).optional(),
  range: z.enum(['day', 'week', 'month', 'year', 'all']).optional(),
  visibility: z.enum(['all', 'public', 'verifiedOnly', 'premiumOnly']).optional(),
  tags: tagsQuerySchema,
  domain: z.string().trim().max(200).optional(),
  q: z.string().trim().max(120).optional(),
  author: z.string().trim().max(120).optional(),
  hidden: z.enum(['only']).optional(),
  limit: z.coerce.number().int().min(1).max(50).optional(),
  cursor: z.string().max(200).optional(),
});

const commentsListSchema = z.object({
  author: z.string().trim().max(120).optional(),
  limit: z.coerce.number().int().min(1).max(50).optional(),
  cursor: z.string().max(200).optional(),
});

const createThreadSchema = z.object({
  title: z.string().trim().min(1).max(BOARD_TITLE_MAX),
  url: z.string().trim().max(2048).nullable().optional(),
  body: z.string().max(2000).nullable().optional(),
  image: z
    .object({
      r2Key: z.string().trim().min(1).max(512),
      width: z.number().int().positive().nullable().optional(),
      height: z.number().int().positive().nullable().optional(),
      alt: z.string().max(500).nullable().optional(),
    })
    .nullable()
    .optional(),
  tags: z.array(z.string().trim().max(40)).max(BOARD_MAX_TAGS).optional(),
  visibility: visibilitySchema.optional(),
  showInFeed: z.boolean().optional(),
});

const updateThreadSchema = z.object({
  title: z.string().trim().min(1).max(BOARD_TITLE_MAX).optional(),
  url: z.string().trim().max(2048).nullable().optional(),
  body: z.string().max(2000).optional(),
  tags: z.array(z.string().trim().max(40)).max(BOARD_MAX_TAGS).optional(),
});

const createCommentSchema = z.object({
  body: z.string().trim().min(1).max(2000),
  parentId: z.string().trim().min(1).nullable().optional(),
});

const preferencesSchema = z.object({
  shareToFeedDefault: z.boolean().optional(),
  articlePostToBoardDefault: z.boolean().optional(),
});

const interactThrottle = { default: { limit: rateLimitLimit('interact', 180), ttl: rateLimitTtl('interact', 60) } };
const createThrottle = { default: { limit: rateLimitLimit('postCreate', 30), ttl: rateLimitTtl('postCreate', 60) } };

@ApiTags('Board')
@Controller('board')
export class BoardController {
  constructor(private readonly board: BoardService) {}

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
      sort: parsed.sort ?? (q ? 'new' : 'top'),
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
      showInFeed: parsed.showInFeed ?? true,
    });
    return { data };
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
