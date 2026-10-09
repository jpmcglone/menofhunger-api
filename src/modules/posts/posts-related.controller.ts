import {
  postRelationsQuerySchema,
  postDiscoveryQuerySchema,
} from "./posts.schemas";
import { postReadThrottle } from "./posts-http.policy";
import { Inject } from "@nestjs/common";
import { PostsFeedComposeService } from "./posts-feed-compose.service";
import { PostsFeedMediaService } from "./posts-feed-media.service";
import { PostsDiscoverMoreService } from "./posts-discover-more.service";
import { Controller, Get, Param, Query, Res, UseGuards } from "@nestjs/common";
import { ApiTags } from "@nestjs/swagger";
import { Throttle } from "@nestjs/throttler";
import type { Response } from "express";
import { OptionalAuthGuard } from "../auth/auth-public-api";
import { OptionalCurrentUserId } from "../users/users.decorator";
import { setReadCache } from "../../common/http-cache";

@ApiTags("Feed & Posts")
@Controller("posts")
export class PostsRelatedController {
  constructor(
    @Inject(PostsFeedComposeService)
    private readonly postsCompose: Pick<
      PostsFeedComposeService,
      "composeFeedPostDtos"
    >,
    @Inject(PostsFeedMediaService)
    private readonly postsMedia: Pick<
      PostsFeedMediaService,
      "listQuotes" | "listReposters"
    >,
    @Inject(PostsDiscoverMoreService)
    private readonly postsDiscoverMore: Pick<
      PostsDiscoverMoreService,
      "listDiscoverMore"
    >,
  ) {}

  @UseGuards(OptionalAuthGuard)
  @Throttle(postReadThrottle)
  @Get(":id/reposts")
  async listReposters(
    @OptionalCurrentUserId() userId: string | undefined,
    @Param("id") id: string,
    @Query() query: unknown,
    @Res({ passthrough: true }) httpRes: Response,
  ) {
    const { cursor, limit } = postRelationsQuerySchema.parse(query);
    const viewerUserId = userId ?? null;
    const result = await this.postsMedia.listReposters({
      viewerUserId,
      postId: id,
      limit: limit ?? 30,
      cursor: cursor ?? null,
    });
    setReadCache(httpRes, { viewerUserId });
    return {
      data: result.authors,
      pagination: { nextCursor: result.nextCursor },
    };
  }

  @UseGuards(OptionalAuthGuard)
  @Throttle(postReadThrottle)
  @Get(":id/quotes")
  async listQuotes(
    @OptionalCurrentUserId() userId: string | undefined,
    @Param("id") id: string,
    @Query() query: unknown,
    @Res({ passthrough: true }) httpRes: Response,
  ) {
    const { cursor, limit } = postRelationsQuerySchema.parse(query);
    const viewerUserId = userId ?? null;
    const result = await this.postsMedia.listQuotes({
      viewerUserId,
      postId: id,
      limit: limit ?? 20,
      cursor: cursor ?? null,
    });
    const dtos = await this.postsCompose.composeFeedPostDtos({
      viewerUserId,
      filteredPosts: result.posts,
      collapsedItemsByItemId: new Map(),
    });
    setReadCache(httpRes, { viewerUserId });
    return { data: dtos, pagination: { nextCursor: result.nextCursor } };
  }

  @UseGuards(OptionalAuthGuard)
  @Throttle(postReadThrottle)
  @Get(":id/discover-more")
  async listDiscoverMore(
    @OptionalCurrentUserId() userId: string | undefined,
    @Param("id") id: string,
    @Query() query: unknown,
    @Res({ passthrough: true }) httpRes: Response,
  ) {
    const { cursor, limit, seed } = postDiscoveryQuerySchema.parse(query);
    const viewerUserId = userId ?? null;
    const result = await this.postsDiscoverMore.listDiscoverMore({
      viewerUserId,
      postId: id,
      limit: limit ?? 8,
      cursor: cursor ?? null,
      shuffleSeed: seed ?? null,
    });
    setReadCache(httpRes, { viewerUserId });
    return {
      data: result.posts,
      pagination: { nextCursor: result.nextCursor },
    };
  }
}
