import { Body, Controller, Post, UseGuards } from '@nestjs/common';
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
  async create(@Body() body: unknown, @OptionalCurrentUserId() userId?: string) {
    const parsed = createSchema.parse(body);
    const email = parsed.email?.trim() || null;

    const created = await this.feedback.create({
      category: parsed.category,
      email,
      subject: parsed.subject,
      details: parsed.details,
      userId,
    });

    return { data: toFeedbackDto(created) };
  }
}
