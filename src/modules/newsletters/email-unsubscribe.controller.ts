import { Body, Controller, Get, Post, Query, Res } from '@nestjs/common';
import { Throttle } from '@nestjs/throttler';
import type { Response } from 'express';
import { z } from 'zod';
import { rateLimitLimit, rateLimitTtl } from '../../common/throttling/rate-limit.resolver';
import { AppConfigService } from '../app/app-config.service';
import { tokenFromUnsubscribeRequest } from './email-unsubscribe.helpers';
import { NewslettersService } from './newsletters.service';

function frontendBase(raw: string | null): string {
  return ((raw ?? '').trim() || 'https://menofhunger.com').replace(/\/$/, '');
}

const tokenSchema = z.object({ token: z.string().trim().min(1) });

@Controller('email')
export class EmailUnsubscribeController {
  constructor(
    private readonly newsletters: NewslettersService,
    private readonly appConfig: AppConfigService,
  ) {}

  @Get('unsubscribe')
  @Throttle({
    default: {
      limit: rateLimitLimit('interact', 20),
      ttl: rateLimitTtl('interact', 60),
    },
  })
  unsubscribeGet(@Query('token') token: string | undefined, @Res() res: Response) {
    // GET must not mutate. Clients prefetch unsubscribe URLs; one-click (RFC 8058)
    // is POST-only and already flips newsletters off. Humans land on the site page.
    const baseUrl = frontendBase(this.appConfig.frontendBaseUrl());
    const raw = (token ?? '').trim();
    if (!raw) {
      return res.redirect(302, `${baseUrl}/email/unsubscribe`);
    }
    return res.redirect(
      302,
      `${baseUrl}/email/unsubscribe?token=${encodeURIComponent(raw)}`,
    );
  }

  @Post('unsubscribe')
  @Throttle({
    default: {
      limit: rateLimitLimit('interact', 20),
      ttl: rateLimitTtl('interact', 60),
    },
  })
  async unsubscribePost(@Query('token') queryToken: string | undefined, @Body() body: unknown) {
    const parsed = tokenSchema.parse({ token: tokenFromUnsubscribeRequest(queryToken, body) });
    const result = await this.newsletters.unsubscribeWithToken(parsed.token);
    return { data: result };
  }
}
