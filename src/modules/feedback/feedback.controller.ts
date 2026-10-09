import { Body, Controller, Post, Req, UseGuards } from '@nestjs/common';
import type { Request } from 'express';
import { ApiTags, ApiOperation } from '@nestjs/swagger';
import { OptionalAuthGuard } from '../auth/auth-public-api';
import { OptionalCurrentUserId } from '../users/users.decorator';
import { FeedbackService } from './feedback.service';
import { toFeedbackDto } from '../../common/dto';
import { createSchema } from './feedback.schemas';

@ApiTags('Feedback')
@UseGuards(OptionalAuthGuard)
@Controller('feedback')
export class FeedbackController {
  constructor(private readonly feedback: FeedbackService) {}

  @ApiOperation({ summary: 'Submit user feedback (bug, feature, account, other) - optional auth' })
  @Post()
  async create(@Req() req: Request, @Body() body: unknown, @OptionalCurrentUserId() userId?: string) {
    const parsed = createSchema.parse(body);
    const email = parsed.email?.trim() || null;

    const xff = String(req.headers['x-forwarded-for'] ?? '').split(',')[0]?.trim() || '';
    const submitterIp = (xff || req.ip || '').trim() || null;

    const created = await this.feedback.create({
      category: parsed.category,
      email,
      subject: parsed.subject,
      details: parsed.details,
      userId,
      submitterIp,
    });

    return { data: toFeedbackDto(created) };
  }
}
