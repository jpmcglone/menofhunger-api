import { BadRequestException, Body, Controller, Get, Param, Patch, Query, Req, UseGuards } from "@nestjs/common";
import { AdminGuard } from "./admin.guard";
import { FeedbackService } from "../feedback/feedback.service";
import { toFeedbackAdminDto } from "../../common/dto";
import { PresenceRealtimeService } from "../presence/presence-realtime.service";
import type { AdminRequest } from "./admin.guard";
import { AppConfigService } from "../app/app-config.service";
import { listSchema, updateSchema } from './admin-feedback.schemas';

@UseGuards(AdminGuard)
@Controller("admin/feedback")
export class AdminFeedbackController {
  constructor(
    private readonly feedback: FeedbackService,
    private readonly presenceRealtime: PresenceRealtimeService,
    private readonly config: AppConfigService,
  ) {}

  @Get()
  async list(@Query() query: unknown) {
    const parsed = listSchema.parse(query);
    const limit = parsed.limit ?? 50;

    const publicAssetBaseUrl = this.config.r2()?.publicBaseUrl ?? null;
    const { rows, nextCursor } = await this.feedback.listAdmin({
      limit,
      cursor: parsed.cursor ?? null,
      status: parsed.status,
      category: parsed.category,
      q: parsed.q,
      feedbackId: parsed.feedbackId,
    });

    return {
      data: rows.map((row) => toFeedbackAdminDto(row, publicAssetBaseUrl)),
      pagination: { nextCursor },
    };
  }

  @Patch(":id")
  async update(
    @Param("id") id: string,
    @Body() body: unknown,
    @Req() req: AdminRequest,
  ) {
    const parsed = updateSchema.parse(body);
    if (parsed.status === undefined && parsed.adminNote === undefined) {
      throw new BadRequestException("No changes provided.");
    }

    const publicAssetBaseUrl = this.config.r2()?.publicBaseUrl ?? null;
    const updated = await this.feedback.updateAdmin(id, {
      status: parsed.status,
      adminNote: parsed.adminNote,
    });

    // Realtime: cross-tab admin sync (self only).
    try {
      this.presenceRealtime.emitAdminUpdated(req.user!.id, {
        kind: "feedback",
        action: "updated",
        id: updated.id,
      });
    } catch {
      // Best-effort
    }

    return { data: toFeedbackAdminDto(updated, publicAssetBaseUrl) };
  }
}
