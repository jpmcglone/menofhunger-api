import { Body, Controller, Get, Post, UseGuards } from '@nestjs/common';
import { z } from 'zod';
import { ApiTags, ApiOperation } from '@nestjs/swagger';
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

@ApiTags('Verification')
@UseGuards(AuthGuard)
@Controller('verification')
export class VerificationController {
  constructor(private readonly verification: VerificationService) {}

  /** Start (or resume) identity verification. Provider integration comes later. */
  @ApiOperation({ summary: 'Create (or resume) an identity verification request' })
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
  @ApiOperation({ summary: 'Get the authenticated user\'s current verification status and latest request' })
  @Get('me')
  async me(@CurrentUserId() userId?: string) {
    const data = await this.verification.getMyVerificationStatus({ userId: userId ?? null });
    return { data };
  }
}

