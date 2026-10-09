import { Inject } from "@nestjs/common";
import { PostsEngagementService } from "./posts-engagement.service";
import { Controller, Delete, Param, Post, UseGuards } from "@nestjs/common";
import { ApiTags } from "@nestjs/swagger";
import { Throttle } from "@nestjs/throttler";
import { AuthGuard } from "../auth/auth-public-api";
import { CurrentUserId } from "../users/users.decorator";
import {
  rateLimitLimit,
  rateLimitTtl,
} from "../../common/throttling/rate-limit.resolver";

@ApiTags("Feed & Posts")
@Controller("posts")
export class PostsEngagementController {
  constructor(
    @Inject(PostsEngagementService)
    private readonly postsEngagement: Pick<
      PostsEngagementService,
      "boostPost" | "repostPost" | "unboostPost" | "unrepostPost"
    >,
  ) {}

  @UseGuards(AuthGuard)
  @Throttle({
    default: {
      limit: rateLimitLimit("interact", 180),
      ttl: rateLimitTtl("interact", 60),
    },
  })
  @Post(":id/boost")
  async boost(@Param("id") id: string, @CurrentUserId() userId: string) {
    const result = await this.postsEngagement.boostPost({ userId, postId: id });
    return { data: result };
  }

  @UseGuards(AuthGuard)
  @Throttle({
    default: {
      limit: rateLimitLimit("interact", 180),
      ttl: rateLimitTtl("interact", 60),
    },
  })
  @Delete(":id/boost")
  async unboost(@Param("id") id: string, @CurrentUserId() userId: string) {
    const result = await this.postsEngagement.unboostPost({
      userId,
      postId: id,
    });
    return { data: result };
  }

  @UseGuards(AuthGuard)
  @Throttle({
    default: {
      limit: rateLimitLimit("interact", 180),
      ttl: rateLimitTtl("interact", 60),
    },
  })
  @Post(":id/repost")
  async repost(@Param("id") id: string, @CurrentUserId() userId: string) {
    const result = await this.postsEngagement.repostPost({
      userId,
      postId: id,
    });
    return { data: result };
  }

  @UseGuards(AuthGuard)
  @Throttle({
    default: {
      limit: rateLimitLimit("interact", 180),
      ttl: rateLimitTtl("interact", 60),
    },
  })
  @Delete(":id/repost")
  async unrepost(@Param("id") id: string, @CurrentUserId() userId: string) {
    const result = await this.postsEngagement.unrepostPost({
      userId,
      postId: id,
    });
    return { data: result };
  }
}
