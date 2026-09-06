import { Controller, Get, Param, Res, UseGuards } from "@nestjs/common";
import type { Response } from "express";
import { AuthGuard } from "../auth/auth.guard";
import { CurrentUserId } from "../users/users.decorator";
import { ConversationsService } from "./conversations.service";
@Controller("posts")
@UseGuards(AuthGuard)
export class ConversationsController {
  constructor(private readonly conversations: ConversationsService) {}
  @Get("insights/weekly")
  async weekly(
    @CurrentUserId() userId: string,
    @Res({ passthrough: true }) res: Response,
  ) {
    res.setHeader("Cache-Control", "private, no-store");
    return { data: await this.conversations.insights(userId) };
  }
  @Get(":id/insights")
  async post(
    @CurrentUserId() userId: string,
    @Param("id") id: string,
    @Res({ passthrough: true }) res: Response,
  ) {
    res.setHeader("Cache-Control", "private, no-store");
    return { data: await this.conversations.insights(userId, id) };
  }
}
