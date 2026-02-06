import { Body, Controller, Get, Post, UseGuards } from '@nestjs/common';
import { z } from 'zod';
import { AuthGuard } from '../auth/auth.guard';
import { CurrentUserId } from '../users/users.decorator';
import { toVerificationRequestPublicDto } from '../../common/dto';
import { VerificationService } from './verification.service';

const createRequestSchema = z
  .object({
    // Provider-agnostic for now; this is here so we can extend later without breaking clients.
    providerHint: z.string().trim().min(1).max(50).optional(),
  })
  .partial();

@UseGuards(AuthGuard)
@Controller('verification')
export class VerificationController {
  constructor(private readonly verification: VerificationService) {}

  /** Start (or resume) identity verification. Provider integration comes later. */
  @Post('request')
  async createRequest(@Body() body: unknown, @CurrentUserId() userId?: string) {
    const parsed = createRequestSchema.parse(body ?? {});
    const req = await this.verification.createRequestForUser({
      userId: userId ?? null,
      providerHint: parsed.providerHint ?? null,
    });
    return { data: toVerificationRequestPublicDto(req) };
  }

  /** Get current verification status + most recent request. */
  @Get('me')
  async me(@CurrentUserId() userId?: string) {
    const data = await this.verification.getMyVerificationStatus({ userId: userId ?? null });
    return { data };
  }
}

