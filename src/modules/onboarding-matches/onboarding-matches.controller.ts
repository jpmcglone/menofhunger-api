import { Body, Controller, Post, UseGuards } from '@nestjs/common';
import { Throttle } from '@nestjs/throttler';
import { z } from 'zod';
import type { OnboardingMatchesDto } from '../../common/dto/onboarding-matches.dto';
import { rateLimitLimit, rateLimitTtl } from '../../common/throttling/rate-limit.resolver';
import { AuthGuard } from '../auth/auth.guard';
import { CurrentUserId } from '../users/users.decorator';
import { OnboardingMatchesService } from './onboarding-matches.service';

const bodySchema = z.object({ intent: z.string().trim().max(300).optional() }).strict();

@Controller('me/onboarding')
@UseGuards(AuthGuard)
export class OnboardingMatchesController {
  constructor(private readonly matches: OnboardingMatchesService) {}

  /** Suggested groups and people from the member's interests and an optional sentence about what they want. */
  @Throttle({ default: { limit: rateLimitLimit('publicRead', 30), ttl: rateLimitTtl('publicRead', 60) } })
  @Post('matches')
  async list(@CurrentUserId() userId: string, @Body() body: unknown): Promise<{ data: OnboardingMatchesDto }> {
    const { intent } = bodySchema.parse(body ?? {});
    return { data: await this.matches.matches(userId, intent ?? '') };
  }
}
