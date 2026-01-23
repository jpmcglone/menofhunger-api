import { Body, Controller, Get, Post, Req, Res } from '@nestjs/common';
import type { Request, Response } from 'express';
import { z } from 'zod';
import { AuthService } from './auth.service';
import { OTP_CODE_LENGTH } from './auth.constants';
import { normalizePhone } from './auth.utils';

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

@Controller('auth')
export class AuthController {
  constructor(private readonly auth: AuthService) {}

  @Post('phone/start')
  async start(@Body() body: unknown) {
    const parsed = startSchema.parse(body);
    const phone = normalizePhone(parsed.phone);
    return await this.auth.startPhoneAuth(phone);
  }

  @Post('phone/verify')
  async verify(@Body() body: unknown, @Res({ passthrough: true }) res: Response) {
    const parsed = verifySchema.parse(body);
    const phone = normalizePhone(parsed.phone);
    return await this.auth.verifyPhoneCode(phone, parsed.code, res);
  }

  @Get('me')
  async me(@Req() req: Request) {
    // cookie-parser populates req.cookies
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const token = (req as any).cookies?.moh_session as string | undefined;
    const result = await this.auth.meFromSessionToken(token);
    if (!result) return { user: null };
    return result;
  }

  @Post('logout')
  async logout(@Req() req: Request, @Res({ passthrough: true }) res: Response) {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const token = (req as any).cookies?.moh_session as string | undefined;
    return await this.auth.logout(token, res);
  }
}

