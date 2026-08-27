import { Controller, Get, Param, Res } from '@nestjs/common';
import { ApiOperation, ApiResponse, ApiTags } from '@nestjs/swagger';
import { Throttle } from '@nestjs/throttler';
import type { Response } from 'express';
import { publicCacheControl } from '../../common/http-cache';
import { rateLimitLimit, rateLimitTtl } from '../../common/throttling/rate-limit.resolver';
import { PostsService } from '../posts/posts.service';
import { PublicProfilesService } from '../users/public-profiles.service';

@ApiTags('Public')
@Controller('public')
export class PublicController {
  constructor(
    private readonly posts: PostsService,
    private readonly profiles: PublicProfilesService,
  ) {}

  @Throttle({
    default: {
      limit: rateLimitLimit('publicRead', 600),
      ttl: rateLimitTtl('publicRead', 60),
    },
  })
  @ApiOperation({
    summary: 'Get the most recent public post',
    description: 'No authentication required. Returns the newest published, non-group, public-visibility post.',
  })
  @ApiResponse({ status: 200, description: 'The post in the standard { data: PostDto } envelope.' })
  @ApiResponse({ status: 404, description: 'No public posts exist yet.' })
  @Get('posts/latest')
  async getLatestPost(@Res({ passthrough: true }) res: Response) {
    const post = await this.posts.getLatestPublic();
    res.setHeader('Cache-Control', publicCacheControl(30, 60));
    return { data: post };
  }

  @Throttle({
    default: {
      limit: rateLimitLimit('publicRead', 600),
      ttl: rateLimitTtl('publicRead', 60),
    },
  })
  @ApiOperation({
    summary: 'Get a public post by ID',
    description:
      'No authentication required. Returns the standard PostDto only for published, non-group posts with public visibility; all other IDs return 404.',
  })
  @ApiResponse({ status: 200, description: 'The public post in the standard { data: PostDto } envelope.' })
  @ApiResponse({ status: 404, description: 'The post is missing or not public.' })
  @Get('posts/:id')
  async getPost(@Param('id') id: string, @Res({ passthrough: true }) res: Response) {
    const post = await this.posts.getPublicById(id);
    res.setHeader('Cache-Control', publicCacheControl(60, 300));
    return { data: post };
  }

  @Throttle({
    default: {
      limit: rateLimitLimit('publicRead', 300),
      ttl: rateLimitTtl('publicRead', 60),
    },
  })
  @ApiOperation({
    summary: 'Get a public profile by username or ID',
    description:
      'No authentication required. Returns the same anonymous-safe public profile payload used by Men of Hunger clients.',
  })
  @ApiResponse({ status: 200, description: 'The public profile in the standard { data } envelope.' })
  @ApiResponse({ status: 404, description: 'The public profile does not exist.' })
  @Get('users/:usernameOrId')
  async getProfile(
    @Param('usernameOrId') usernameOrId: string,
    @Res({ passthrough: true }) res: Response,
  ) {
    const result = await this.profiles.getAnonymousProfile(usernameOrId);
    res.setHeader('Cache-Control', publicCacheControl(300, 600));
    return { data: result.payload };
  }
}
