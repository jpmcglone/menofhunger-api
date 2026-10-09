import type { Response } from 'express';
import type { Readable } from 'node:stream';
import { BadRequestException, Body, Headers, Res, StreamableFile, Controller, Get, Param, Patch, Query, Req, UseGuards } from '@nestjs/common';
import { z } from 'zod';
import { AdminGuard, type AdminRequest } from './admin.guard';
import { ReportsService } from '../reports/reports.service';
import { toReportAdminDto } from '../../common/dto';
import { PresenceRealtimeService } from '../presence/presence-realtime.service';
import { listSchema, updateSchema } from './admin-reports.schemas';

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
      sort: parsed.sort,
    });

    return {
      data: rows.map((row) => toReportAdminDto(row)),
      pagination: { nextCursor },
    };
  }

  @Get(':id/media/:mediaId')
  async reportedMedia(@Param('id') id: string, @Param('mediaId') mediaId: string, @Query() query: unknown, @Headers('range') range: string | undefined, @Res({ passthrough: true }) response: Response) {
    const thumbnail = z.object({ thumbnail: z.enum(['true', 'false']).optional() }).parse(query).thumbnail === 'true';
    const object = await this.reports.readReportedMedia(id, mediaId, thumbnail, range);
    response.setHeader('Cache-Control', 'private, no-store');
    response.setHeader('X-Content-Type-Options', 'nosniff');
    response.setHeader('Accept-Ranges', 'bytes');
    if (object.ContentRange) { response.status(206); response.setHeader('Content-Range', object.ContentRange); }
    return new StreamableFile(object.Body as Readable, { type: object.ContentType ?? 'application/octet-stream', length: object.ContentLength });
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

