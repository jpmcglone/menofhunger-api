import { BadRequestException, Body, Controller, Get, Param, Patch, Query, UseGuards } from '@nestjs/common';
import { z } from 'zod';
import { AdminGuard } from './admin.guard';
import { FeedbackService } from '../feedback/feedback.service';
import { toFeedbackAdminDto } from '../../common/dto';

const listSchema = z.object({
  q: z.string().trim().max(200).optional(),
  status: z.enum(['new', 'triaged', 'resolved']).optional(),
  category: z.enum(['bug', 'feature', 'account', 'other']).optional(),
  limit: z.coerce.number().int().min(1).max(100).optional(),
  cursor: z.string().optional(),
});

const updateSchema = z.object({
  status: z.enum(['new', 'triaged', 'resolved']).optional(),
  adminNote: z.union([z.string().trim().max(2000), z.null()]).optional(),
});

@UseGuards(AdminGuard)
@Controller('admin/feedback')
export class AdminFeedbackController {
  constructor(private readonly feedback: FeedbackService) {}

  @Get()
  async list(@Query() query: unknown) {
    const parsed = listSchema.parse(query);
    const limit = parsed.limit ?? 50;

    const { rows, nextCursor } = await this.feedback.listAdmin({
      limit,
      cursor: parsed.cursor ?? null,
      status: parsed.status,
      category: parsed.category,
      q: parsed.q,
    });

    return {
      data: rows.map((row) => toFeedbackAdminDto(row)),
      pagination: { nextCursor },
    };
  }

  @Patch(':id')
  async update(@Param('id') id: string, @Body() body: unknown) {
    const parsed = updateSchema.parse(body);
    if (parsed.status === undefined && parsed.adminNote === undefined) {
      throw new BadRequestException('No changes provided.');
    }

    const updated = await this.feedback.updateAdmin(id, {
      status: parsed.status,
      adminNote: parsed.adminNote,
    });

    return { data: toFeedbackAdminDto(updated) };
  }
}
