import { BadRequestException, Body, Controller, Get, Post, Req, Res } from '@nestjs/common';
import type { Request, Response } from 'express';
import { Throttle } from '@nestjs/throttler';
import { z } from 'zod';
import { AuthService } from './auth.service';
import { OTP_CODE_LENGTH } from './auth.constants';
import { normalizePhone } from './auth.utils';
import { rateLimitLimit, rateLimitTtl } from '../../common/throttling/rate-limit.resolver';

const startSchema = z.object({
  phone: z.string().min(1),
});

const verifySchema = z.object({
  phone: z.string().min(1),
  code: z
    .string()
    .min(OTP_CODE_LENGTH)
    .max(OTP_CODE_LENGTH)
    .regex(/^\d+$/, 'Code must be numeric'),
});

const existsSchema = z.object({
  phone: z.string().min(1),
});

@Controller('auth')
export class AuthController {
  constructor(private readonly auth: AuthService) {}

  @Throttle({
    default: {
      limit: rateLimitLimit('authStart', 8),
      ttl: rateLimitTtl('authStart', 60),
    },
  })
  @Post('phone/start')
  async start(@Body() body: unknown) {
    const parsed = startSchema.parse(body);
    let phone: string;
    try {
      phone = normalizePhone(parsed.phone);
    } catch {
      throw new BadRequestException('Invalid phone number format');
    }
    return await this.auth.startPhoneAuth(phone);
  }

  @Get('phone/exists')
  async exists(@Req() req: Request) {
    const parsed = existsSchema.parse(req.query);
    let phone: string;
    try {
      phone = normalizePhone(parsed.phone);
    } catch {
      throw new BadRequestException('Invalid phone number format');
    }
    const exists = await this.auth.phoneExists(phone);
    return { exists };
  }

  @Throttle({
    default: {
      limit: rateLimitLimit('authVerify', 20),
      ttl: rateLimitTtl('authVerify', 60),
    },
  })
  @Post('phone/verify')
  async verify(@Body() body: unknown, @Res({ passthrough: true }) res: Response) {
    const parsed = verifySchema.parse(body);
    let phone: string;
    try {
      phone = normalizePhone(parsed.phone);
    } catch {
      throw new BadRequestException('Invalid phone number format');
    }
    return await this.auth.verifyPhoneCode(phone, parsed.code, res);
  }

  @Get('me')
  async me(@Req() req: Request) {
    // cookie-parser populates req.cookies
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const token = (req as any).cookies?.moh_session as string | undefined;
    const user = await this.auth.meFromSessionToken(token);
    return { user: user ?? null };
  }

  @Post('logout')
  async logout(@Req() req: Request, @Res({ passthrough: true }) res: Response) {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const token = (req as any).cookies?.moh_session as string | undefined;
    return await this.auth.logout(token, res);
  }
}

