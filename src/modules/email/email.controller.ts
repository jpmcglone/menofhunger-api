import { Body, Controller, Get, Post, Query, Res, UseGuards } from '@nestjs/common';
import { Throttle } from '@nestjs/throttler';
import type { Response } from 'express';
import { AuthGuard } from '../auth/auth.guard';
import { CurrentUserId } from '../users/users.decorator';
import { EmailVerificationService } from './email-verification.service';
import { AppConfigService } from '../app/app-config.service';
import { z } from 'zod';
import { rateLimitLimit, rateLimitTtl } from '../../common/throttling/rate-limit.resolver';

function safeBaseUrl(raw: string | null): string {
  const base = (raw ?? '').trim() || 'https://menofhunger.com';
  return base.replace(/\/$/, '');
}

@Controller('email')
export class EmailController {
  constructor(
    private readonly verification: EmailVerificationService,
    private readonly appConfig: AppConfigService,
  ) {}

  @UseGuards(AuthGuard)
  @Throttle({
    default: {
      // Even if the UI is spam-clicked, keep this endpoint very tight.
      limit: rateLimitLimit('interact', 6),
      ttl: rateLimitTtl('interact', 60),
    },
  })
  @Post('verification/resend')
  async resendVerification(@CurrentUserId() userId: string) {
    const result = await this.verification.resendForUser(userId);
    return { data: result };
  }

  @Get('verification/confirm')
  async confirmVerification(@Query('token') token: string | undefined, @Res() res: Response) {
    const baseUrl = safeBaseUrl(this.appConfig.frontendBaseUrl());
    const raw = (token ?? '').trim();
    // Redirect to frontend verification page (login-required).
    const redirect = raw ? `${baseUrl}/email/verify?token=${encodeURIComponent(raw)}` : `${baseUrl}/settings/account?email_verified=0`;
    return res.redirect(302, redirect);
  }

  @UseGuards(AuthGuard)
  @Post('verification/confirm')
  async confirmVerificationAuthed(@CurrentUserId() userId: string, @Body() body: unknown) {
    const parsed = z.object({ token: z.string().trim().min(1) }).parse(body);
    const result = await this.verification.confirmForUser({ userId, token: parsed.token });
    return { data: result };
  }
}

