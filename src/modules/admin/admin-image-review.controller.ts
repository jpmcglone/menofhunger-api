import { Body, Controller, Delete, Get, Param, Query, Req, UseGuards } from '@nestjs/common';
import type { Request } from 'express';
import { z } from 'zod';
import { AdminGuard, type AdminRequest } from './admin.guard';
import { AdminImageReviewService } from './admin-image-review.service';

const listSchema = z.object({
  limit: z.coerce.number().int().min(1).max(100).optional(),
  cursor: z.string().optional(),
  q: z.string().optional(),
  showDeleted: z.coerce.boolean().optional(),
  onlyOrphans: z.coerce.boolean().optional(),
  sync: z.coerce.boolean().optional(),
  kind: z.enum(['all', 'image', 'video']).optional(),
});

const deleteSchema = z.object({
  reason: z.string().trim().min(1).max(200),
});

@UseGuards(AdminGuard)
@Controller('admin/media-review')
export class AdminImageReviewController {
  constructor(private readonly svc: AdminImageReviewService) {}

  @Get()
  async list(@Query() query: unknown) {
    const parsed = listSchema.parse(query);
    const result = await this.svc.list({
      limit: parsed.limit ?? 60,
      cursor: parsed.cursor ?? null,
      q: parsed.q ?? null,
      showDeleted: parsed.showDeleted ?? false,
      onlyOrphans: parsed.onlyOrphans ?? false,
      sync: parsed.sync ?? false,
      kind: parsed.kind ?? 'all',
    });
    return { data: result.items, pagination: { nextCursor: result.nextCursor } };
  }

  @Get(':assetId')
  async get(@Param('assetId') assetId: string) {
    const result = await this.svc.getById(assetId);
    return { data: result };
  }

  @Delete(':assetId')
  async del(@Req() req: Request, @Param('assetId') assetId: string, @Body() body: unknown) {
    const parsed = deleteSchema.parse(body);
    const adminUserId = (req as AdminRequest).user?.id ?? '';
    const result = await this.svc.deleteById({ id: assetId, adminUserId, reason: parsed.reason });
    return { data: result };
  }
}

