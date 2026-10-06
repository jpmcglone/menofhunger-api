import { Body, Controller, Post, UseGuards } from '@nestjs/common';
import { z } from 'zod';
import { ApiTags, ApiOperation } from '@nestjs/swagger';
import { AuthGuard } from '../auth/auth.guard';
import { CurrentUserId } from '../users/users.decorator';
import { ReportsService } from './reports.service';
import { toReportDto } from '../../common/dto';

const createSchema = z.object({
  targetType: z.enum(['post', 'user', 'message', 'article']),
  subjectPostId: z.string().cuid().optional(), subjectUserId: z.string().cuid().optional(),
  subjectMessageId: z.string().cuid().optional(), subjectArticleId: z.string().cuid().optional(),
  reason: z.enum(['spam', 'harassment', 'hate', 'sexual', 'violence', 'illegal', 'other']),
  details: z.union([z.string().trim().min(1).max(5000), z.null()]).optional(),
}).strict().superRefine((value, context) => {
  const keys = { post: 'subjectPostId', user: 'subjectUserId', message: 'subjectMessageId', article: 'subjectArticleId' } as const;
  for (const key of Object.values(keys)) {
    if (key === keys[value.targetType] ? !value[key] : Boolean(value[key])) context.addIssue({ code: z.ZodIssueCode.custom, message: `Provide only the ${value.targetType} being reported.`, path: [key] });
  }
});

@ApiTags('Moderation')
@UseGuards(AuthGuard)
@Controller('reports')
export class ReportsController {
  constructor(private readonly reports: ReportsService) {}

  @ApiOperation({ summary: 'Create a report for a post, user, message or article (spam, harassment, hate, etc.)' })
  @Post()
  async create(@Body() body: unknown, @CurrentUserId() userId: string) {
    const parsed = createSchema.parse(body);

    const created = await this.reports.create({
      reporterUserId: userId,
      targetType: parsed.targetType,
      subjectPostId: parsed.subjectPostId ?? null,
      subjectUserId: parsed.subjectUserId ?? null,
      subjectMessageId: parsed.subjectMessageId ?? null,
      subjectArticleId: parsed.subjectArticleId ?? null,
      reason: parsed.reason,
      details: parsed.details ?? null,
    });

    return { data: toReportDto(created) };
  }
}

