import { postPollVoteSchema } from "./posts.schemas";
import { Inject } from "@nestjs/common";
import { PollsService } from "./polls.service";
import { Body, Controller, Param, Post, UseGuards } from "@nestjs/common";
import { ApiTags } from "@nestjs/swagger";
import { Throttle } from "@nestjs/throttler";
import { AuthGuard } from "../auth/auth-public-api";
import { AppConfigService } from "../app/app-config.service";
import { CurrentUserId } from "../users/users.decorator";
import { toPostPollDto } from "./post.dto";
import {
  rateLimitLimit,
  rateLimitTtl,
} from "../../common/throttling/rate-limit.resolver";

@ApiTags("Feed & Posts")
@Controller("posts")
export class PostsPollController {
  constructor(
    @Inject(PollsService)
    private readonly postsPolls: Pick<PollsService, "skipPoll" | "voteOnPoll">,
    private readonly appConfig: AppConfigService,
  ) {}

  @UseGuards(AuthGuard)
  @Throttle({
    default: {
      limit: rateLimitLimit("interact", 180),
      ttl: rateLimitTtl("interact", 60),
    },
  })
  @Post(":id/poll/vote")
  async voteOnPoll(
    @Param("id") id: string,
    @Body() body: unknown,
    @CurrentUserId() userId: string,
  ) {
    const parsed = postPollVoteSchema.parse(body);
    const result = await this.postsPolls.voteOnPoll({
      userId,
      postId: id,
      optionId: parsed.optionId,
    });
    return {
      data: {
        poll: toPostPollDto(
          result.poll,
          this.appConfig.r2()?.publicBaseUrl ?? null,
          {
            viewerVotedOptionId: result.viewerVotedOptionId,
          },
        ),
      },
    };
  }

  @UseGuards(AuthGuard)
  @Throttle({
    default: {
      limit: rateLimitLimit("interact", 180),
      ttl: rateLimitTtl("interact", 60),
    },
  })
  @Post(":id/poll/skip")
  async skipPoll(@Param("id") id: string, @CurrentUserId() userId: string) {
    const result = await this.postsPolls.skipPoll({ userId, postId: id });
    return {
      data: {
        poll: toPostPollDto(
          result.poll,
          this.appConfig.r2()?.publicBaseUrl ?? null,
          {
            viewerVotedOptionId: null,
            viewerSkipped: true,
          },
        ),
      },
    };
  }
}
