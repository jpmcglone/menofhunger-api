import { Body, Controller, Delete, Get, Param, Patch, Post, UseGuards } from '@nestjs/common';
import { Throttle } from '@nestjs/throttler';
import { z } from 'zod';
import { AuthGuard } from '../auth/auth.guard';
import { CurrentUserId } from '../users/users.decorator';
import { rateLimitLimit, rateLimitTtl } from '../../common/throttling/rate-limit.resolver';
import { BookmarksService } from './bookmarks.service';

const createCollectionSchema = z.object({
  name: z.string().trim().min(1).max(40),
});

const renameCollectionSchema = z.object({
  name: z.string().trim().min(1).max(40),
});

const setBookmarkSchema = z.object({
  collectionId: z.string().trim().min(1).optional().nullable(),
});

@Controller('bookmarks')
export class BookmarksController {
  constructor(private readonly bookmarks: BookmarksService) {}

  @UseGuards(AuthGuard)
  @Get('collections')
  async listCollections(@CurrentUserId() userId: string) {
    return await this.bookmarks.listCollections({ userId });
  }

  @UseGuards(AuthGuard)
  @Throttle({
    default: {
      limit: rateLimitLimit('interact', 180),
      ttl: rateLimitTtl('interact', 60),
    },
  })
  @Post('collections')
  async createCollection(@CurrentUserId() userId: string, @Body() body: unknown) {
    const parsed = createCollectionSchema.parse(body);
    return await this.bookmarks.createCollection({ userId, name: parsed.name });
  }

  @UseGuards(AuthGuard)
  @Throttle({
    default: {
      limit: rateLimitLimit('interact', 180),
      ttl: rateLimitTtl('interact', 60),
    },
  })
  @Patch('collections/:id')
  async renameCollection(@CurrentUserId() userId: string, @Param('id') id: string, @Body() body: unknown) {
    const parsed = renameCollectionSchema.parse(body);
    return await this.bookmarks.renameCollection({ userId, id, name: parsed.name });
  }

  @UseGuards(AuthGuard)
  @Throttle({
    default: {
      limit: rateLimitLimit('interact', 180),
      ttl: rateLimitTtl('interact', 60),
    },
  })
  @Delete('collections/:id')
  async deleteCollection(@CurrentUserId() userId: string, @Param('id') id: string) {
    return await this.bookmarks.deleteCollection({ userId, id });
  }

  @UseGuards(AuthGuard)
  @Throttle({
    default: {
      limit: rateLimitLimit('interact', 180),
      ttl: rateLimitTtl('interact', 60),
    },
  })
  @Post(':postId')
  async setBookmark(@CurrentUserId() userId: string, @Param('postId') postId: string, @Body() body: unknown) {
    const parsed = setBookmarkSchema.parse(body ?? {});
    return await this.bookmarks.setBookmark({ userId, postId, collectionId: parsed.collectionId ?? null });
  }

  @UseGuards(AuthGuard)
  @Throttle({
    default: {
      limit: rateLimitLimit('interact', 180),
      ttl: rateLimitTtl('interact', 60),
    },
  })
  @Delete(':postId')
  async removeBookmark(@CurrentUserId() userId: string, @Param('postId') postId: string) {
    return await this.bookmarks.removeBookmark({ userId, postId });
  }
}

