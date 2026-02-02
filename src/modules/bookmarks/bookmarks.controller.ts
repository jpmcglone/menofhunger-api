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
  // Multi-folder support: prefer `collectionIds`. Keep `collectionId` for backwards compatibility.
  collectionIds: z.array(z.string().trim().min(1)).max(40).optional().nullable(),
  collectionId: z.string().trim().min(1).optional().nullable(),
});

@Controller('bookmarks')
export class BookmarksController {
  constructor(private readonly bookmarks: BookmarksService) {}

  @UseGuards(AuthGuard)
  @Get('collections')
  async listCollections(@CurrentUserId() userId: string) {
    const result = await this.bookmarks.listCollections({ userId });
    return { data: result };
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
    const result = await this.bookmarks.createCollection({ userId, name: parsed.name });
    return { data: result };
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
    const result = await this.bookmarks.renameCollection({ userId, id, name: parsed.name });
    return { data: result };
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
    const result = await this.bookmarks.deleteCollection({ userId, id });
    return { data: result };
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
    const ids =
      Array.isArray(parsed.collectionIds) ? parsed.collectionIds : parsed.collectionId ? [parsed.collectionId] : null;
    const result = await this.bookmarks.setBookmark({ userId, postId, collectionIds: ids });
    return { data: result };
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
    const result = await this.bookmarks.removeBookmark({ userId, postId });
    return { data: result };
  }
}

