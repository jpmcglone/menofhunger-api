import { Injectable, ServiceUnavailableException } from '@nestjs/common';
import type { Response } from 'express';
import { PrismaService } from '../prisma/prisma.service';
import {
  AUTH_COOKIE_NAME,
  OTP_RESEND_SECONDS,
  OTP_TTL_MINUTES,
  SESSION_TTL_DAYS,
} from './auth.constants';
import { generateNumericCode, hmacSha256Hex, randomSessionToken } from './auth.utils';

type Env = {
  NODE_ENV: 'development' | 'test' | 'production';
  OTP_HMAC_SECRET: string;
  SESSION_HMAC_SECRET: string;
  COOKIE_DOMAIN?: string;
  TWILIO_ACCOUNT_SID?: string;
  TWILIO_AUTH_TOKEN?: string;
  TWILIO_FROM_NUMBER?: string;
};

@Injectable()
export class AuthService {
  constructor(private readonly prisma: PrismaService) {}

  private getEnv(): Env {
    const nodeEnv = (process.env.NODE_ENV ?? 'development') as Env['NODE_ENV'];
    return {
      NODE_ENV: nodeEnv,
      OTP_HMAC_SECRET: process.env.OTP_HMAC_SECRET ?? 'dev-otp-secret-change-me',
      SESSION_HMAC_SECRET: process.env.SESSION_HMAC_SECRET ?? 'dev-session-secret-change-me',
      COOKIE_DOMAIN: process.env.COOKIE_DOMAIN,
      TWILIO_ACCOUNT_SID: process.env.TWILIO_ACCOUNT_SID,
      TWILIO_AUTH_TOKEN: process.env.TWILIO_AUTH_TOKEN,
      TWILIO_FROM_NUMBER: process.env.TWILIO_FROM_NUMBER,
    };
  }

  private isProd() {
    return this.getEnv().NODE_ENV === 'production';
  }

  async startPhoneAuth(phone: string) {
    const now = new Date();

    const latest = await this.prisma.phoneOtp.findFirst({
      where: { phone },
      orderBy: { createdAt: 'desc' },
    });

    if (latest?.resendAfterAt && latest.resendAfterAt > now) {
      const retryAfterSeconds = Math.max(
        1,
        Math.ceil((latest.resendAfterAt.getTime() - now.getTime()) / 1000),
      );
      return { ok: true as const, retryAfterSeconds };
    }

    const code = generateNumericCode();

    // In production, we require successful SMS delivery before we create/store the OTP.
    // This avoids creating OTPs that cannot be delivered when Twilio isn't configured yet.
    if (this.isProd()) {
      try {
        await this.sendOtpSms(phone, code);
      } catch (err) {
        throw new ServiceUnavailableException(
          'SMS login is not configured yet. Please try again later.',
        );
      }
    }

    const otpSecret = this.getEnv().OTP_HMAC_SECRET;
    const codeHash = hmacSha256Hex(otpSecret, `${phone}:${code}`);

    const expiresAt = new Date(now.getTime() + OTP_TTL_MINUTES * 60_000);
    const resendAfterAt = new Date(now.getTime() + OTP_RESEND_SECONDS * 1000);

    await this.prisma.phoneOtp.create({
      data: {
        phone,
        codeHash,
        expiresAt,
        resendAfterAt,
      },
    });

    return { ok: true as const, retryAfterSeconds: OTP_RESEND_SECONDS };
  }

  async verifyPhoneCode(phone: string, code: string, res: Response) {
    const now = new Date();
    const { NODE_ENV, OTP_HMAC_SECRET } = this.getEnv();

    const otp = await this.prisma.phoneOtp.findFirst({
      where: {
        phone,
        consumedAt: null,
        expiresAt: { gt: now },
      },
      orderBy: { createdAt: 'desc' },
    });

    if (!otp) {
      return { ok: false as const, error: 'No active code found. Please resend.' };
    }

    const isDevBypass = NODE_ENV !== 'production' && code === '000000';
    if (!isDevBypass) {
      const hash = hmacSha256Hex(OTP_HMAC_SECRET, `${phone}:${code}`);
      if (hash !== otp.codeHash) {
        return { ok: false as const, error: 'Invalid code. Please try again.' };
      }
    }

    await this.prisma.phoneOtp.update({
      where: { id: otp.id },
      data: { consumedAt: now },
    });

    const existing = await this.prisma.user.findUnique({ where: { phone } });
    const isNewUser = !existing;

    const user = existing
      ? existing
      : await this.prisma.user.create({
          data: {
            phone,
            username: null,
            usernameIsSet: false,
          },
        });

    const session = await this.createSessionAndSetCookie(user.id, res);

    return {
      ok: true as const,
      isNewUser,
      user: {
        id: user.id,
        phone: user.phone,
        username: user.username,
        usernameIsSet: user.usernameIsSet,
        name: user.name,
        bio: user.bio,
      },
      sessionId: session.id,
    };
  }

  async meFromSessionToken(token: string | undefined) {
    if (!token) return null;
    const now = new Date();
    const tokenHash = hmacSha256Hex(this.getEnv().SESSION_HMAC_SECRET, token);

    const session = await this.prisma.session.findFirst({
      where: {
        tokenHash,
        revokedAt: null,
        expiresAt: { gt: now },
      },
      include: { user: true },
    });

    if (!session) return null;
    return {
      user: {
        id: session.user.id,
        phone: session.user.phone,
        username: session.user.username,
        usernameIsSet: session.user.usernameIsSet,
        name: session.user.name,
        bio: session.user.bio,
      },
    };
  }

  async logout(token: string | undefined, res: Response) {
    if (token) {
      const tokenHash = hmacSha256Hex(this.getEnv().SESSION_HMAC_SECRET, token);
      await this.prisma.session.updateMany({
        where: { tokenHash, revokedAt: null },
        data: { revokedAt: new Date() },
      });
    }

    this.clearAuthCookie(res);
    return { ok: true as const };
  }

  private cookieOptions(expires: Date) {
    const isProd = this.isProd();
    const domain = isProd ? process.env.COOKIE_DOMAIN ?? '.menofhunger.com' : undefined;
    return {
      httpOnly: true,
      secure: isProd,
      sameSite: 'lax' as const,
      domain,
      path: '/',
      expires,
    };
  }

  private setAuthCookie(token: string, expires: Date, res: Response) {
    res.cookie(AUTH_COOKIE_NAME, token, this.cookieOptions(expires));
  }

  private clearAuthCookie(res: Response) {
    const isProd = this.isProd();
    const domain = isProd ? process.env.COOKIE_DOMAIN ?? '.menofhunger.com' : undefined;
    res.clearCookie(AUTH_COOKIE_NAME, { path: '/', domain });
  }

  private async createSessionAndSetCookie(userId: string, res: Response) {
    const token = randomSessionToken();
    const tokenHash = hmacSha256Hex(this.getEnv().SESSION_HMAC_SECRET, token);

    const now = new Date();
    const expiresAt = new Date(now.getTime() + SESSION_TTL_DAYS * 24 * 60 * 60_000);

    const session = await this.prisma.session.create({
      data: { userId, tokenHash, expiresAt },
    });

    this.setAuthCookie(token, expiresAt, res);
    return session;
  }

  private async sendOtpSms(to: string, code: string) {
    const env = this.getEnv();
    if (!env.TWILIO_ACCOUNT_SID || !env.TWILIO_AUTH_TOKEN || !env.TWILIO_FROM_NUMBER) {
      throw new Error('Twilio env vars missing (TWILIO_ACCOUNT_SID/TWILIO_AUTH_TOKEN/TWILIO_FROM_NUMBER)');
    }

    // Lazy import so local dev doesn't need to load Twilio.
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const twilio = require('twilio');
    const client = twilio(env.TWILIO_ACCOUNT_SID, env.TWILIO_AUTH_TOKEN);

    await client.messages.create({
      to,
      from: env.TWILIO_FROM_NUMBER,
      body: `Your Men of Hunger code is: ${code}`,
    });
  }
}

