import { Body, Controller, Post, UseGuards } from '@nestjs/common';
import { ApiTags, ApiOperation } from '@nestjs/swagger';
import { AuthGuard } from '../auth/auth-public-api';
import { CurrentUserId } from '../users/users.decorator';
import { ReportsService } from './reports.service';
import { toReportDto } from '../../common/dto';
import { createSchema } from './reports.schemas';

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

