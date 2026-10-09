import { Controller, Get, Param, Query, Res, UseGuards } from "@nestjs/common";
import { ApiTags } from "@nestjs/swagger";
import { Throttle } from "@nestjs/throttler";
import type { Response } from "express";
import { OptionalAuthGuard } from "../auth/auth-public-api";
import { OptionalCurrentUserId } from "../users/users.decorator";
import { PostsListQueryService } from "./posts-list-query.service";
import { PostPermalinkService } from "./posts-permalink.service";
import {
  rateLimitLimit,
  rateLimitTtl,
} from "../../common/throttling/rate-limit.resolver";

@ApiTags("Feed & Posts")
@Controller("posts")
export class PostsController {
  constructor(
    private readonly listQuery: PostsListQueryService,
    private readonly permalink: PostPermalinkService,
  ) {}

  @UseGuards(OptionalAuthGuard)
  @Throttle({
    default: {
      limit: rateLimitLimit("publicRead", 240),
      ttl: rateLimitTtl("publicRead", 60),
    },
  })
  @Get()
  async list(
    @OptionalCurrentUserId() userId: string | undefined,
    @Query() query: unknown,
    @Res({ passthrough: true }) httpRes: Response,
  ) {
    return this.listQuery.listPosts(userId, query, httpRes);
  }

  @UseGuards(OptionalAuthGuard)
  @Throttle({
    default: {
      limit: rateLimitLimit("publicRead", 600),
      ttl: rateLimitTtl("publicRead", 60),
    },
  })
  @Get(":id")
  async getById(
    @OptionalCurrentUserId() userId: string | undefined,
    @Param("id") id: string,
    @Res({ passthrough: true }) httpRes: Response,
  ) {
    return this.permalink.getPostById(userId, id, httpRes);
  }
}
