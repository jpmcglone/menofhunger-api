import {
  Body,
  Controller,
  Delete,
  Get,
  Param,
  Patch,
  Post,
  Query,
  UseGuards,
} from '@nestjs/common';
import { Throttle } from '@nestjs/throttler';
import { z } from 'zod';
import { AuthGuard } from '../auth/auth.guard';
import { OptionalAuthGuard } from '../auth/optional-auth.guard';
import { CurrentUserId, OptionalCurrentUserId } from '../users/users.decorator';
import { rateLimitLimit, rateLimitTtl } from '../../common/throttling/rate-limit.resolver';
import { ArticlesService } from './articles.service';

const visibilitySchema = z.enum(['public', 'verifiedOnly', 'premiumOnly']);

const createSchema = z.object({
  title: z.string().trim().max(200).optional(),
  visibility: visibilitySchema.optional(),
});

const saveSchema = z.object({
  title: z.string().trim().max(200).optional(),
  body: z.string().max(500_000).optional(),
  thumbnailR2Key: z.string().nullable().optional(),
  visibility: visibilitySchema.optional(),
});

const listSchema = z.object({
  limit: z.coerce.number().int().min(1).max(50).optional(),
  cursor: z.string().optional(),
  authorUsername: z.string().optional(),
  sort: z.enum(['new', 'trending']).optional(),
  visibility: z.enum(['all', 'public', 'verifiedOnly', 'premiumOnly']).optional(),
  mine: z.coerce.boolean().optional(),
  followingOnly: z.coerce.boolean().optional(),
  includeRestricted: z.coerce.boolean().optional(),
});

const draftsListSchema = z.object({
  limit: z.coerce.number().int().min(1).max(50).optional(),
  cursor: z.string().optional(),
  visibility: z.enum(['all', 'public', 'verifiedOnly', 'premiumOnly']).optional(),
});

const commentListSchema = z.object({
  limit: z.coerce.number().int().min(1).max(50).optional(),
  cursor: z.string().optional(),
});

const commentCreateSchema = z.object({
  body: z.string().trim().min(1).max(5000),
  parentId: z.string().optional(),
});

const commentUpdateSchema = z.object({
  body: z.string().trim().min(1).max(5000),
});

const reactionSchema = z.object({
  reactionId: z.string().trim().min(1),
});

const shareSchema = z.object({
  body: z.string().trim().max(1000).optional(),
  visibility: visibilitySchema.optional(),
});

const interactThrottle = {
  default: {
    limit: rateLimitLimit('interact', 60),
    ttl: rateLimitTtl('interact', 60),
  },
};

const readThrottle = {
  default: {
    limit: rateLimitLimit('read', 120),
    ttl: rateLimitTtl('read', 60),
  },
};

@Controller('articles')
export class ArticlesController {
  constructor(private readonly articles: ArticlesService) {}

  // ─── Trending articles ─────────────────────────────────────────────────────

  @UseGuards(OptionalAuthGuard)
  @Throttle(readThrottle)
  @Get('trending')
  async trending(@OptionalCurrentUserId() userId: string | undefined, @Query() query: unknown) {
    const parsed = z.object({ limit: z.coerce.number().int().min(1).max(20).optional() }).parse(query);
    const result = await this.articles.listTrending({ viewerUserId: userId, limit: parsed.limit });
    return { data: result };
  }

  // ─── List published ────────────────────────────────────────────────────────

  @UseGuards(OptionalAuthGuard)
  @Throttle(readThrottle)
  @Get()
  async list(@OptionalCurrentUserId() userId: string | undefined, @Query() query: unknown) {
    const parsed = listSchema.parse(query);
    const result = await this.articles.listPublished({
      viewerUserId: userId,
      limit: parsed.limit,
      cursor: parsed.cursor,
      authorUsername: parsed.authorUsername,
      sort: parsed.sort,
      visibilityFilter: parsed.visibility === 'all' ? undefined : parsed.visibility,
      mine: parsed.mine,
      followingOnly: parsed.followingOnly,
      includeRestricted: parsed.includeRestricted,
    });
    return { data: result.articles, pagination: { nextCursor: result.nextCursor } };
  }

  // ─── List drafts ───────────────────────────────────────────────────────────

  @UseGuards(AuthGuard)
  @Throttle(readThrottle)
  @Get('drafts')
  async listDrafts(@CurrentUserId() userId: string, @Query() query: unknown) {
    const parsed = draftsListSchema.parse(query);
    const result = await this.articles.listDrafts({
      userId,
      limit: parsed.limit,
      cursor: parsed.cursor,
      visibilityFilter: parsed.visibility === 'all' ? undefined : parsed.visibility,
    });
    return { data: result.articles, pagination: { nextCursor: result.nextCursor } };
  }

  // ─── Get single ───────────────────────────────────────────────────────────

  @UseGuards(OptionalAuthGuard)
  @Throttle(readThrottle)
  @Get(':id')
  async getById(
    @OptionalCurrentUserId() userId: string | undefined,
    @Param('id') id: string,
  ) {
    const article = await this.articles.getById(id, userId);
    return { data: article };
  }

  // ─── Create ───────────────────────────────────────────────────────────────

  @UseGuards(AuthGuard)
  @Throttle(interactThrottle)
  @Post()
  async create(@CurrentUserId() userId: string, @Body() body: unknown) {
    const parsed = createSchema.parse(body);
    const article = await this.articles.create(userId, parsed);
    return { data: article };
  }

  // ─── Auto-save ────────────────────────────────────────────────────────────

  @UseGuards(AuthGuard)
  @Throttle(interactThrottle)
  @Patch(':id/save')
  async save(@CurrentUserId() userId: string, @Param('id') id: string, @Body() body: unknown) {
    const parsed = saveSchema.parse(body);
    const article = await this.articles.save(userId, id, parsed);
    return { data: article };
  }

  // ─── Publish ──────────────────────────────────────────────────────────────

  @UseGuards(AuthGuard)
  @Throttle(interactThrottle)
  @Post(':id/publish')
  async publish(@CurrentUserId() userId: string, @Param('id') id: string) {
    const article = await this.articles.publish(userId, id);
    return { data: article };
  }

  // ─── Unpublish ────────────────────────────────────────────────────────────

  @UseGuards(AuthGuard)
  @Throttle(interactThrottle)
  @Post(':id/unpublish')
  async unpublish(@CurrentUserId() userId: string, @Param('id') id: string) {
    const article = await this.articles.unpublish(userId, id);
    return { data: article };
  }

  // ─── Delete ───────────────────────────────────────────────────────────────

  @UseGuards(AuthGuard)
  @Throttle(interactThrottle)
  @Delete(':id')
  async delete(@CurrentUserId() userId: string, @Param('id') id: string) {
    const result = await this.articles.delete(userId, id);
    return { data: result };
  }

  // ─── Boost / Unboost ──────────────────────────────────────────────────────

  @UseGuards(AuthGuard)
  @Throttle(interactThrottle)
  @Post(':id/boost')
  async boost(@CurrentUserId() userId: string, @Param('id') id: string) {
    const result = await this.articles.boost(userId, id);
    return { data: result };
  }

  @UseGuards(AuthGuard)
  @Throttle(interactThrottle)
  @Delete(':id/boost')
  async unboost(@CurrentUserId() userId: string, @Param('id') id: string) {
    const result = await this.articles.unboost(userId, id);
    return { data: result };
  }

  // ─── Reactions ────────────────────────────────────────────────────────────

  @UseGuards(AuthGuard)
  @Throttle(interactThrottle)
  @Post(':id/reactions')
  async addReaction(
    @CurrentUserId() userId: string,
    @Param('id') id: string,
    @Body() body: unknown,
  ) {
    const { reactionId } = reactionSchema.parse(body);
    const result = await this.articles.addReaction(userId, id, reactionId);
    return { data: result };
  }

  @UseGuards(AuthGuard)
  @Throttle(interactThrottle)
  @Delete(':id/reactions/:reactionId')
  async removeReaction(
    @CurrentUserId() userId: string,
    @Param('id') id: string,
    @Param('reactionId') reactionId: string,
  ) {
    const result = await this.articles.removeReaction(userId, id, reactionId);
    return { data: result };
  }

  // ─── Comments ─────────────────────────────────────────────────────────────

  @UseGuards(OptionalAuthGuard)
  @Throttle(readThrottle)
  @Get(':id/comments')
  async listComments(
    @OptionalCurrentUserId() userId: string | undefined,
    @Param('id') id: string,
    @Query() query: unknown,
  ) {
    const parsed = commentListSchema.parse(query);
    const result = await this.articles.listComments({
      articleId: id,
      viewerUserId: userId,
      limit: parsed.limit,
      cursor: parsed.cursor,
    });
    return { data: result.comments, pagination: { nextCursor: result.nextCursor } };
  }

  @UseGuards(OptionalAuthGuard)
  @Throttle(readThrottle)
  @Get(':id/comments/:commentId/replies')
  async listReplies(
    @OptionalCurrentUserId() userId: string | undefined,
    @Param('id') id: string,
    @Param('commentId') commentId: string,
    @Query() query: unknown,
  ) {
    const parsed = commentListSchema.parse(query);
    const result = await this.articles.listCommentReplies({
      articleId: id,
      parentCommentId: commentId,
      viewerUserId: userId,
      limit: parsed.limit,
      cursor: parsed.cursor,
    });
    return { data: result.comments, pagination: { nextCursor: result.nextCursor } };
  }

  @UseGuards(AuthGuard)
  @Throttle(interactThrottle)
  @Post(':id/comments')
  async createComment(
    @CurrentUserId() userId: string,
    @Param('id') id: string,
    @Body() body: unknown,
  ) {
    const parsed = commentCreateSchema.parse(body);
    const comment = await this.articles.createComment(userId, id, {
      body: parsed.body,
      parentId: parsed.parentId,
    });
    return { data: comment };
  }

  @UseGuards(AuthGuard)
  @Throttle(interactThrottle)
  @Patch('comments/:commentId')
  async updateComment(
    @CurrentUserId() userId: string,
    @Param('commentId') commentId: string,
    @Body() body: unknown,
  ) {
    const { body: text } = commentUpdateSchema.parse(body);
    const comment = await this.articles.updateComment(userId, commentId, text);
    return { data: comment };
  }

  @UseGuards(AuthGuard)
  @Throttle(interactThrottle)
  @Delete('comments/:commentId')
  async deleteComment(
    @CurrentUserId() userId: string,
    @Param('commentId') commentId: string,
  ) {
    const result = await this.articles.deleteComment(userId, commentId);
    return { data: result };
  }

  // ─── Comment reactions ────────────────────────────────────────────────────

  @UseGuards(AuthGuard)
  @Throttle(interactThrottle)
  @Post('comments/:commentId/reactions')
  async addCommentReaction(
    @CurrentUserId() userId: string,
    @Param('commentId') commentId: string,
    @Body() body: unknown,
  ) {
    const { reactionId } = reactionSchema.parse(body);
    const result = await this.articles.addCommentReaction(userId, commentId, reactionId);
    return { data: result };
  }

  @UseGuards(AuthGuard)
  @Throttle(interactThrottle)
  @Delete('comments/:commentId/reactions/:reactionId')
  async removeCommentReaction(
    @CurrentUserId() userId: string,
    @Param('commentId') commentId: string,
    @Param('reactionId') reactionId: string,
  ) {
    const result = await this.articles.removeCommentReaction(userId, commentId, reactionId);
    return { data: result };
  }

  // ─── Share post ───────────────────────────────────────────────────────────

  @UseGuards(AuthGuard)
  @Throttle(interactThrottle)
  @Post(':id/share')
  async createSharePost(
    @CurrentUserId() userId: string,
    @Param('id') id: string,
    @Body() body: unknown,
  ) {
    const parsed = shareSchema.parse(body);
    const result = await this.articles.createSharePost(userId, id, parsed.body ?? '', parsed.visibility);
    return { data: result };
  }
}
