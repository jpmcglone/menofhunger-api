import { BadRequestException, Body, Controller, Get, Param, Patch, Query, Req, UseGuards } from '@nestjs/common';
import { z } from 'zod';
import { AdminGuard, type AdminRequest } from './admin.guard';
import { ReportsService } from '../reports/reports.service';
import { toReportAdminDto } from '../../common/dto';
import { PresenceRealtimeService } from '../presence/presence-realtime.service';

const listSchema = z.object({
  q: z.string().trim().max(200).optional(),
  status: z.enum(['pending', 'dismissed', 'actionTaken']).optional(),
  targetType: z.enum(['post', 'user']).optional(),
  reason: z.enum(['spam', 'harassment', 'hate', 'sexual', 'violence', 'illegal', 'other']).optional(),
  limit: z.coerce.number().int().min(1).max(100).optional(),
  cursor: z.string().optional(),
});

const updateSchema = z.object({
  status: z.enum(['pending', 'dismissed', 'actionTaken']).optional(),
  adminNote: z.union([z.string().trim().max(2000), z.null()]).optional(),
});

@UseGuards(AdminGuard)
@Controller('admin/reports')
export class AdminReportsController {
  constructor(
    private readonly reports: ReportsService,
    private readonly presenceRealtime: PresenceRealtimeService,
  ) {}

  @Get()
  async list(@Query() query: unknown) {
    const parsed = listSchema.parse(query);
    const limit = parsed.limit ?? 50;

    const { rows, nextCursor } = await this.reports.listAdmin({
      limit,
      cursor: parsed.cursor ?? null,
      status: parsed.status,
      targetType: parsed.targetType,
      reason: parsed.reason,
      q: parsed.q,
    });

    return {
      data: rows.map((row) => toReportAdminDto(row)),
      pagination: { nextCursor },
    };
  }

  @Patch(':id')
  async update(@Param('id') id: string, @Body() body: unknown, @Req() req: AdminRequest) {
    const parsed = updateSchema.parse(body);
    if (parsed.status === undefined && parsed.adminNote === undefined) {
      throw new BadRequestException('No changes provided.');
    }

    const updated = await this.reports.updateAdmin(id, {
      adminId: req.user!.id,
      status: parsed.status,
      adminNote: parsed.adminNote,
    });

    // Realtime: cross-tab admin sync (self only).
    try {
      this.presenceRealtime.emitAdminUpdated(req.user!.id, {
        kind: 'reports',
        action: 'updated',
        id: updated.id,
      });
    } catch {
      // Best-effort
    }

    return { data: toReportAdminDto(updated) };
  }
}

