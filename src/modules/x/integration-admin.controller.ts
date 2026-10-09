import type { IntegrationSpendDiagnosticsDto, IntegrationOperationsDto, IntegrationSpendControlDto, IntegrationReconciliationResultDto } from "../../common/dto/integrations.dto";
import { Body, ConflictException, Controller, Get, Param, Post, Query, UseGuards } from "@nestjs/common";
import { z } from "zod";
import { AdminGuard } from "../admin/admin.guard";
import { CurrentUserId } from "../users/users.decorator";
import { IntegrationAdminService } from "./integration-admin.service";

@Controller("admin/integrations")
@UseGuards(AdminGuard)
export class IntegrationAdminController {
  constructor(private readonly integrations: IntegrationAdminService) {}

  @Get("operations")
  async operations(): Promise<{ data: IntegrationOperationsDto }> {
    return { data: await this.integrations.operations() };
  }

  @Post("controls")
  async controls(
    @CurrentUserId() adminUserId: string,
    @Body() body: unknown,
  ): Promise<{ data: IntegrationSpendControlDto }> {
    const cap = z.number().int().min(0).max(2_000_000_000).nullable();
    const input = z
      .object({
        expectedRevision: z.number().int().nonnegative(),
        reason: z.string().trim().min(10).max(1000),
        paused: z.boolean(),
        companyMonthlyMicros: cap,
        companyDailyMicros: cap,
        xMonthlyMicros: cap,
        reserveMonthlyMicros: cap,
      })
      .strict()
      .parse(body);
    return { data: await this.integrations.updateControls(adminUserId, input) };
  }

  @Get("spend")
  async spend(
    @Query() query: unknown,
  ): Promise<{ data: IntegrationSpendDiagnosticsDto }> {
    const { month } = z
      .object({
        month: z
          .string()
          .regex(/^\d{4}-(0[1-9]|1[0-2])$/)
          .optional(),
      })
      .strict()
      .parse(query);
    return { data: await this.integrations.spend(month) };
  }

  @Post("usage/:id/reconcile")
  async reconcile(
    @CurrentUserId() adminUserId: string,
    @Param("id") id: string,
    @Body() body: unknown,
  ): Promise<{ data: IntegrationReconciliationResultDto }> {
    const input = z
      .object({
        status: z.enum(["settled", "released"]),
        chargedMicros: z.number().int().min(0).max(2_000_000_000),
        expectedStatus: z.enum([
          "reserved",
          "uncertain",
          "settled",
          "released",
        ]),
        evidence: z.string().trim().min(10).max(1000),
      })
      .strict()
      .parse(body);
    if (id.length > 300) throw new ConflictException("Invalid operation.");
    // Reconciliation never dispatches a new external publication.
    return { data: await this.integrations.reconcile(adminUserId, id, input) };
  }
}
