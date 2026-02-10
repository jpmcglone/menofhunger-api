import { Body, Controller, Post, Req, UseGuards } from '@nestjs/common';
import type { Request } from 'express';
import { z } from 'zod';
import { OptionalAuthGuard } from '../auth/optional-auth.guard';
import { OptionalCurrentUserId } from '../users/users.decorator';
import { FeedbackService } from './feedback.service';
import { toFeedbackDto } from '../../common/dto';

const createSchema = z.object({
  category: z.enum(['bug', 'feature', 'account', 'other']),
  email: z.string().trim().email().optional().nullable(),
  subject: z.string().trim().min(1).max(200),
  details: z.string().trim().min(1).max(5000),
});

@UseGuards(OptionalAuthGuard)
@Controller('feedback')
export class FeedbackController {
  constructor(private readonly feedback: FeedbackService) {}

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
