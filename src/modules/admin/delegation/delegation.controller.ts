import {
  Body,
  Controller,
  Get,
  Header,
  Param,
  Query,
  Patch,
  Post,
  Req,
  Res,
  UseGuards,
} from "@nestjs/common";
import type { Response } from "express";
import { z } from "zod";
import { AdminGuard, type AdminRequest } from "../admin.guard";
import { DelegationService } from "./delegation.service";
import { delegationId } from "./delegation.schemas";
@UseGuards(AdminGuard)
@Controller("admin/delegation")
export class DelegationController {
  constructor(private readonly service: DelegationService) {}
  @Get()
  async workspace(
    @Req() req: AdminRequest,
    @Res({ passthrough: true }) res: Response,
  ) {
    res.setHeader("Cache-Control", "no-store");
    return { data: await this.service.workspace(req.user!.id) };
  }
  @Post("jobs")
  async create(@Req() req: AdminRequest, @Body() body: unknown) {
    return { data: await this.service.create(req.user!.id, body) };
  }
  @Get("jobs/:id")
  async get(
    @Req() req: AdminRequest,
    @Param("id") id: string,
    @Query("before") before: string | undefined,
    @Res({ passthrough: true }) res: Response,
  ) {
    res.setHeader("Cache-Control", "no-store");
    return {
      data: await this.service.get(
        req.user!.id,
        delegationId.parse(id),
        before ? delegationId.parse(before) : undefined,
      ),
    };
  }
  @Get("jobs/:id/drafts")
  @Header("Cache-Control", "no-store")
  async drafts(@Req() req: AdminRequest, @Param("id") id: string) {
    return {
      data: await this.service.drafts(req.user!.id, delegationId.parse(id)),
    };
  }
  @Post("jobs/:id/proposals")
  async prepare(
    @Req() req: AdminRequest,
    @Param("id") id: string,
    @Body() raw: unknown,
  ) {
    const body = z
      .object({ requestId: z.string().uuid(), action: z.unknown() })
      .strict()
      .parse(raw);
    return {
      data: await this.service.prepare(
        req.user!.id,
        delegationId.parse(id),
        body.requestId,
        body.action,
      ),
    };
  }
  @Patch("jobs/:id")
  async edit(
    @Req() req: AdminRequest,
    @Param("id") id: string,
    @Body() raw: unknown,
  ) {
    const { revision, ...body } = z
      .object({ revision: z.number().int().positive() })
      .passthrough()
      .parse(raw);
    return {
      data: await this.service.edit(
        req.user!.id,
        delegationId.parse(id),
        revision,
        body,
      ),
    };
  }
  @Post("jobs/:id/control")
  async control(
    @Req() req: AdminRequest,
    @Param("id") id: string,
    @Body() raw: unknown,
  ) {
    const body = z
      .object({
        command: z.enum(["pause", "resume", "cancel", "run"]),
        requestId: z.string().uuid(),
      })
      .strict()
      .parse(raw);
    return {
      data: await this.service.control(
        req.user!.id,
        delegationId.parse(id),
        body.command,
        body.requestId,
      ),
    };
  }
  @Post("actions/:id")
  async decide(
    @Req() req: AdminRequest,
    @Param("id") id: string,
    @Body() raw: unknown,
  ) {
    const body = z
      .object({
        decision: z.enum(["confirm", "cancel"]),
        body: z.string().max(32000).optional(),
      })
      .strict()
      .parse(raw);
    return {
      data: await this.service.decide(
        req.user!.id,
        delegationId.parse(id),
        body.decision,
        body.body,
      ),
    };
  }
  @Get("actions/:id/export")
  async download(
    @Req() req: AdminRequest,
    @Param("id") id: string,
    @Res() res: Response,
  ) {
    const artifact = await this.service.export(
      req.user!.id,
      delegationId.parse(id),
    );
    res.setHeader("Cache-Control", "no-store");
    res.setHeader(
      "Content-Type",
      artifact.format === "ics"
        ? "text/calendar; charset=utf-8"
        : artifact.format === "csv"
          ? "text/csv; charset=utf-8"
          : "text/markdown; charset=utf-8",
    );
    res.setHeader(
      "Content-Disposition",
      `attachment; filename="marv-export.${artifact.format === "markdown" ? "md" : artifact.format}"`,
    );
    res.send(artifact.body);
  }
}
