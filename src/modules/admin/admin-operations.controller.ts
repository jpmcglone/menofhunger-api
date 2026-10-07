import { AdminEngagementService } from './admin-engagement.service';
import {
  Controller,
  Get,
  Param,
  Query,
  UseGuards,
} from "@nestjs/common";
import { z } from "zod";
import { AdminGuard } from "./admin.guard";
import { AdminOperationsService, adminOperationsIdSchema } from "./admin-operations.service";
import type {
  AdminMemberDiagnosticsDto,
  AdminOperationsContentDto,
  AdminOperationsHealthDto,
} from "../../common/dto/admin-operations.dto";

@Controller("admin/operations")
@UseGuards(AdminGuard)
export class AdminOperationsController {
  constructor(
    private readonly engagement: AdminEngagementService,
    private readonly operations: AdminOperationsService,
  ) {}

  @Get('attention')
  async attention() { return { data: await this.engagement.attention() }; }

  @Get('activation')
  async activation(@Query() query: unknown) {
    const input = z.object({
      days: z.coerce.number().pipe(z.union([z.literal(30), z.literal(90)])).default(30),
      stage: z.enum(['joined', 'verified', 'contributed', 'returned']).optional(),
      offset: z.coerce.number().int().min(0).max(10000).default(0),
      limit: z.coerce.number().int().min(1).max(50).default(25),
    }).strict().parse(query);
    return { data: await this.engagement.activation(input) };
  }

  @Get("members/:id")
  async member(
    @Param("id") rawId: string,
  ): Promise<{ data: AdminMemberDiagnosticsDto }> {
    const id = adminOperationsIdSchema.parse(rawId);
    return { data: await this.operations.memberDiagnostics(id) };
  }

  @Get("health")
  async health(): Promise<{ data: AdminOperationsHealthDto }> {
    return { data: await this.engagement.health() };
  }

  @Get("content")
  content(
    @Query() query: unknown,
  ): Promise<{
    data: AdminOperationsContentDto;
    pagination: { nextCursor: string | null };
  }> {
    return this.operations.content(query);
  }
}
