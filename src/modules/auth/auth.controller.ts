import { BadRequestException, Body, Controller, Get, Post, Req, Res } from '@nestjs/common';
import type { Request, Response } from 'express';
import { Throttle } from '@nestjs/throttler';
import { z } from 'zod';
import { getSessionCookie } from '../../common/session-cookie';
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
    const res = await this.auth.startPhoneAuth(phone);
    return { data: res };
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
    return { data: exists };
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
    const result = await this.auth.verifyPhoneCode(phone, parsed.code, res);
    return { data: result };
  }

  @Get('me')
  async me(@Req() req: Request) {
    const token = getSessionCookie(req);
    const user = await this.auth.meFromSessionToken(token);
    return { data: user ?? null };
  }

  @Post('logout')
  async logout(@Req() req: Request, @Res({ passthrough: true }) res: Response) {
    const token = getSessionCookie(req);
    const result = await this.auth.logout(token, res);
    return { data: result };
  }
}

