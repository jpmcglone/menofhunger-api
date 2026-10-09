import { Controller, Get, Query, UseGuards } from "@nestjs/common";
import { AdminGuard } from "./admin.guard";
import { AdminServiceStatusService } from "./admin-service-status.service";
import type { AdminServiceStatusDto } from "../../common/dto/admin-service-status.dto";
import { querySchema } from './admin-services.schemas';

@Controller("admin/services")
@UseGuards(AdminGuard)
export class AdminServicesController {
  constructor(private readonly status: AdminServiceStatusService) {}

  /** Traffic-light status for every external dependency. Reports setting names, never values. */
  @Get()
  async list(@Query() query: unknown): Promise<{ data: AdminServiceStatusDto }> {
    const { refresh } = querySchema.parse(query);
    return { data: await this.status.report({ refresh: refresh === "true" }) };
  }
}
