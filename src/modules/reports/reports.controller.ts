import { Body, Controller, Post, UseGuards } from '@nestjs/common';
import { z } from 'zod';
import { AuthGuard } from '../auth/auth.guard';
import { CurrentUserId } from '../users/users.decorator';
import { ReportsService } from './reports.service';
import { toReportDto } from '../../common/dto';

const createSchema = z
  .object({
    targetType: z.enum(['post', 'user']),
    subjectPostId: z.string().cuid().optional(),
    subjectUserId: z.string().cuid().optional(),
    reason: z.enum(['spam', 'harassment', 'hate', 'sexual', 'violence', 'illegal', 'other']),
    details: z.union([z.string().trim().min(1).max(5000), z.null()]).optional(),
  })
  .superRefine((val, ctx) => {
    if (val.targetType === 'post') {
      if (!val.subjectPostId) {
        ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'subjectPostId is required.', path: ['subjectPostId'] });
      }
      if (val.subjectUserId) {
        ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'subjectUserId is not allowed.', path: ['subjectUserId'] });
      }
      return;
    }

    if (!val.subjectUserId) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'subjectUserId is required.', path: ['subjectUserId'] });
    }
    if (val.subjectPostId) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'subjectPostId is not allowed.', path: ['subjectPostId'] });
    }
  });

@UseGuards(AuthGuard)
@Controller('reports')
export class ReportsController {
  constructor(private readonly reports: ReportsService) {}

  @Post()
  async create(@Body() body: unknown, @CurrentUserId() userId: string) {
    const parsed = createSchema.parse(body);

    const created = await this.reports.create({
      reporterUserId: userId,
      targetType: parsed.targetType,
      subjectPostId: parsed.subjectPostId ?? null,
      subjectUserId: parsed.subjectUserId ?? null,
      reason: parsed.reason,
      details: parsed.details ?? null,
    });

    return { data: toReportDto(created) };
  }
}

