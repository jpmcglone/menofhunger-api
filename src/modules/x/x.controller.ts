import { XPublishingService } from "./x-publishing.service";
import { XNewsService } from "./x-news.service";
import { XAuthorMetricsService } from "./x-author-metrics.service";
import { Param, Res } from "@nestjs/common";
import type { Response } from "express";
import { XProfilePreviewService } from "./x-profile-preview.service";
import { ConnectionIdempotencyService } from "../outbound/connection-idempotency.service";
import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  HttpStatus,
  Post,
  UseGuards,
  Req,
  ForbiddenException,
} from "@nestjs/common";
import { ApiTags } from "@nestjs/swagger";
import { Throttle } from "@nestjs/throttler";
import { z } from "zod";
import { AuthGuard, type AuthedRequest } from "../auth/auth.guard";
import { CurrentUserId } from "../users/users.decorator";
import { XConnectionService } from "./x-connection.service";

const connectSchema = z.object({
  code: z.string().trim().min(1).max(2000),
  state: z.string().trim().min(1).max(200),
});

@ApiTags("integrations")
@Controller("me/integrations/x")
@UseGuards(AuthGuard)
export class XController {
  constructor(
    private readonly connections: XConnectionService,
    private readonly idempotency: ConnectionIdempotencyService,
    private readonly previews: XProfilePreviewService,
    private readonly metrics: XAuthorMetricsService,
    private readonly news: XNewsService,
    private readonly publishing: XPublishingService,
  ) {}

  @Get("publishing/:postId")
  async publishingWorkspace(
    @CurrentUserId() userId: string,
    @Param("postId") postId: string,
  ) {
    return { data: await this.publishing.workspace(userId, postId) };
  }

  @Post("publishing/:postId")
  @Throttle({ default: { limit: 10, ttl: 60_000 } })
  async publishPlan(
    @CurrentUserId() userId: string,
    @Param("postId") postId: string,
    @Body() body: unknown,
    @Req() req: AuthedRequest,
  ) {
    if (req.user?.impersonatedByUserId)
      throw new ForbiddenException("End impersonation before publishing.");
    return { data: await this.publishing.queue(userId, postId, body) };
  }

  @Get("news")
  async digest() {
    return { data: await this.news.get() };
  }

  @Get("metrics/:postId")
  @Throttle({ default: { limit: 30, ttl: 60_000 } })
  async authorMetrics(
    @CurrentUserId() userId: string,
    @Param("postId") postId: string,
    @Res({ passthrough: true }) res: Response,
  ) {
    res.setHeader("Cache-Control", "private, no-store");
    return { data: await this.metrics.get(userId, postId) };
  }

  @Get("profiles/:userId/context")
  @Throttle({ default: { limit: 30, ttl: 60_000 } })
  async profileContext(
    @CurrentUserId() viewerId: string,
    @Param("userId") userId: string,
    @Res({ passthrough: true }) res: Response,
  ) {
    res.setHeader("Cache-Control", "private, no-store");
    return { data: await this.previews.context(viewerId, userId) };
  }

  @Get("profiles/:userId")
  @Throttle({ default: { limit: 30, ttl: 60_000 } })
  async profile(
    @CurrentUserId() viewerId: string,
    @Param("userId") userId: string,
    @Res({ passthrough: true }) res: Response,
  ) {
    res.setHeader("Cache-Control", "private, no-store");
    return { data: await this.previews.get(viewerId, userId) };
  }

  @Get()
  async status(@CurrentUserId() userId: string) {
    return { data: await this.connections.getStatus(userId) };
  }

  @Post("authorize")
  @HttpCode(HttpStatus.OK)
  @Throttle({ default: { limit: 8, ttl: 60_000 } })
  async authorize(@CurrentUserId() userId: string, @Req() req: AuthedRequest) {
    if (req.user?.impersonatedByUserId)
      throw new ForbiddenException(
        "End impersonation before connecting an account.",
      );
    return {
      data: await this.connections.authorize(
        userId,
        req.user?.operatedByUserId ?? userId,
      ),
    };
  }

  @Post("connect")
  @HttpCode(HttpStatus.OK)
  @Throttle({ default: { limit: 8, ttl: 60_000 } })
  async connect(
    @CurrentUserId() userId: string,
    @Body() body: unknown,
    @Req() req: AuthedRequest,
  ) {
    if (req.user?.impersonatedByUserId)
      throw new ForbiddenException(
        "End impersonation before connecting an account.",
      );
    const input = connectSchema.parse(body);
    return {
      data: await this.idempotency.run(
        userId,
        req.path,
        req.get("Idempotency-Key"),
        input,
        () =>
          this.connections.connect(
            userId,
            input,
            req.user?.operatedByUserId ?? userId,
          ),
      ),
    };
  }

  @Delete()
  async disconnect(@CurrentUserId() userId: string) {
    return { data: await this.connections.disconnect(userId) };
  }
}
