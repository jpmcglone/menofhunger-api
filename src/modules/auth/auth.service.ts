import { Injectable, Logger, ServiceUnavailableException } from '@nestjs/common';
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
  DISABLE_TWILIO_IN_DEV?: boolean;
  TWILIO_ACCOUNT_SID?: string;
  TWILIO_AUTH_TOKEN?: string;
  TWILIO_VERIFY_SERVICE_SID?: string;
  TWILIO_FROM_NUMBER?: string;
  TWILIO_MESSAGING_SERVICE_SID?: string;
};

@Injectable()
export class AuthService {
  private readonly logger = new Logger(AuthService.name);

  constructor(private readonly prisma: PrismaService) {}

  private parseBool(v: string | undefined) {
    if (!v) return false;
    return ['1', 'true', 'yes', 'on'].includes(v.trim().toLowerCase());
  }

  private getEnv(): Env {
    const nodeEnv = (process.env.NODE_ENV ?? 'development') as Env['NODE_ENV'];
    return {
      NODE_ENV: nodeEnv,
      OTP_HMAC_SECRET: process.env.OTP_HMAC_SECRET ?? 'dev-otp-secret-change-me',
      SESSION_HMAC_SECRET: process.env.SESSION_HMAC_SECRET ?? 'dev-session-secret-change-me',
      COOKIE_DOMAIN: process.env.COOKIE_DOMAIN,
      DISABLE_TWILIO_IN_DEV: this.parseBool(process.env.DISABLE_TWILIO_IN_DEV),
      TWILIO_ACCOUNT_SID: process.env.TWILIO_ACCOUNT_SID,
      TWILIO_AUTH_TOKEN: process.env.TWILIO_AUTH_TOKEN,
      TWILIO_VERIFY_SERVICE_SID: process.env.TWILIO_VERIFY_SERVICE_SID,
      TWILIO_FROM_NUMBER: process.env.TWILIO_FROM_NUMBER,
      TWILIO_MESSAGING_SERVICE_SID: process.env.TWILIO_MESSAGING_SERVICE_SID,
    };
  }

  private isProd() {
    return this.getEnv().NODE_ENV === 'production';
  }

  private maskPhone(phone: string) {
    const digits = phone.replace(/\D/g, '');
    const last2 = digits.slice(-2);
    return digits.length >= 2 ? `***${last2}` : '***';
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

    const env = this.getEnv();
    const disableTwilioInDev = !this.isProd() && env.DISABLE_TWILIO_IN_DEV;

    const hasVerifyConfig = Boolean(
      env.TWILIO_ACCOUNT_SID && env.TWILIO_AUTH_TOKEN && env.TWILIO_VERIFY_SERVICE_SID,
    );

    const hasMessagingConfig = Boolean(
      env.TWILIO_ACCOUNT_SID &&
        env.TWILIO_AUTH_TOKEN &&
        (env.TWILIO_FROM_NUMBER || env.TWILIO_MESSAGING_SERVICE_SID),
    );

    const canSendSms = !disableTwilioInDev && (hasVerifyConfig || hasMessagingConfig);

    const sendMode: 'verify' | 'messaging' | 'none' =
      canSendSms && hasVerifyConfig
        ? 'verify'
        : canSendSms && hasMessagingConfig
          ? 'messaging'
          : 'none';

    this.logger.log(
      `startPhoneAuth phone=${this.maskPhone(phone)} env=${env.NODE_ENV} twilio=${
        sendMode === 'verify'
          ? 'verify_enabled'
          : sendMode === 'messaging'
            ? 'messaging_enabled'
            : disableTwilioInDev
              ? 'disabled_in_dev'
              : 'not_configured'
      }`,
    );

    // In production, require SMS delivery before creating/storing the OTP.
    // In non-production, if Twilio is configured, send SMS as well; otherwise allow dev flow.
    if (this.isProd() && !canSendSms) {
      throw new ServiceUnavailableException(
        'SMS login is not configured yet. Please try again later.',
      );
    }

    // Store a hash so we can enforce resend cooldown and ensure there is an “active code”
    // when verifying. For Verify mode we don't know the code, so we store a random value.
    let valueToHashForOtp: string;

    if (sendMode === 'verify') {
      try {
        await this.startVerifySms(phone);
        valueToHashForOtp = randomSessionToken();
      } catch (err) {
        this.logger.error(
          `Twilio SMS send failed for phone=${this.maskPhone(phone)}`,
          (err as Error)?.stack,
        );
        throw new ServiceUnavailableException(
          'SMS login is not configured yet. Please try again later.',
        );
      }
    } else if (sendMode === 'messaging') {
      const code = generateNumericCode();
      try {
        await this.sendOtpSms(phone, code);
        valueToHashForOtp = code;
      } catch (err) {
        this.logger.error(
          `Twilio SMS send failed for phone=${this.maskPhone(phone)}`,
          (err as Error)?.stack,
        );
        throw new ServiceUnavailableException(
          'SMS login is not configured yet. Please try again later.',
        );
      }
    } else {
      // Useful when you expect SMS but it's not configured (or disabled in dev).
      this.logger.warn(`Skipping SMS send for phone=${this.maskPhone(phone)}`);
      valueToHashForOtp = randomSessionToken();
    }

    const otpSecret = this.getEnv().OTP_HMAC_SECRET;
    const codeHash = hmacSha256Hex(otpSecret, `${phone}:${valueToHashForOtp}`);

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
    const env = this.getEnv();
    const { NODE_ENV, OTP_HMAC_SECRET } = env;

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
      const disableTwilioInDev = NODE_ENV !== 'production' && Boolean(env.DISABLE_TWILIO_IN_DEV);
      const hasVerifyConfig = Boolean(
        env.TWILIO_ACCOUNT_SID && env.TWILIO_AUTH_TOKEN && env.TWILIO_VERIFY_SERVICE_SID,
      );

      if (!disableTwilioInDev && hasVerifyConfig) {
        try {
          const ok = await this.checkVerifyCode(phone, code);
          if (!ok) return { ok: false as const, error: 'Invalid code. Please try again.' };
        } catch (err) {
          this.logger.error(
            `Twilio Verify check failed for phone=${this.maskPhone(phone)}`,
            (err as Error)?.stack,
          );
          throw new ServiceUnavailableException(
            'SMS login is not configured yet. Please try again later.',
          );
        }
      } else {
        // Legacy/local flow: compare to our stored HMAC.
        const hash = hmacSha256Hex(OTP_HMAC_SECRET, `${phone}:${code}`);
        if (hash !== otp.codeHash) {
          return { ok: false as const, error: 'Invalid code. Please try again.' };
        }
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
    if (!env.TWILIO_ACCOUNT_SID || !env.TWILIO_AUTH_TOKEN) {
      throw new Error('Twilio env vars missing (TWILIO_ACCOUNT_SID/TWILIO_AUTH_TOKEN)');
    }
    if (!env.TWILIO_FROM_NUMBER && !env.TWILIO_MESSAGING_SERVICE_SID) {
      throw new Error(
        'Twilio sender missing (set TWILIO_FROM_NUMBER or TWILIO_MESSAGING_SERVICE_SID)',
      );
    }

    if (!env.TWILIO_ACCOUNT_SID.startsWith('AC')) {
      this.logger.warn(
        `TWILIO_ACCOUNT_SID does not look like an Account SID (expected AC..., got ${env.TWILIO_ACCOUNT_SID.slice(
          0,
          2,
        )}...)`,
      );
    }

    // Lazy import so local dev doesn't need to load Twilio.
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const twilio = require('twilio');
    const client = twilio(env.TWILIO_ACCOUNT_SID, env.TWILIO_AUTH_TOKEN);

    const payload: Record<string, string> = {
      to,
      body: `Your Men of Hunger code is: ${code}`,
    };

    // Twilio supports either a specific `from` number OR a messaging service.
    if (env.TWILIO_MESSAGING_SERVICE_SID) {
      payload.messagingServiceSid = env.TWILIO_MESSAGING_SERVICE_SID;
    } else if (env.TWILIO_FROM_NUMBER) {
      payload.from = env.TWILIO_FROM_NUMBER;
    }

    this.logger.log(
      `Sending SMS via Twilio to=${this.maskPhone(to)} sender=${
        payload.messagingServiceSid ? 'messagingServiceSid' : 'fromNumber'
      }`,
    );

    try {
      const result = await client.messages.create(payload);
      this.logger.log(
        `Twilio SMS queued sid=${String(result?.sid ?? '').slice(0, 8)}... to=${this.maskPhone(to)}`,
      );
    } catch (err) {
      const anyErr = err as any;
      const code = anyErr?.code ?? anyErr?.status;
      const message = anyErr?.message ?? String(err);
      this.logger.error(`Twilio error code=${code ?? 'unknown'} message=${message}`);
      throw err;
    }
  }

  private async startVerifySms(to: string) {
    const env = this.getEnv();
    if (!env.TWILIO_ACCOUNT_SID || !env.TWILIO_AUTH_TOKEN || !env.TWILIO_VERIFY_SERVICE_SID) {
      throw new Error(
        'Twilio Verify env vars missing (TWILIO_ACCOUNT_SID/TWILIO_AUTH_TOKEN/TWILIO_VERIFY_SERVICE_SID)',
      );
    }

    // Lazy import so local dev doesn't need to load Twilio.
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const twilio = require('twilio');
    const client = twilio(env.TWILIO_ACCOUNT_SID, env.TWILIO_AUTH_TOKEN);

    this.logger.log(`Starting Verify SMS to=${this.maskPhone(to)} service=VA...`);

    try {
      const result = await client.verify.v2
        .services(env.TWILIO_VERIFY_SERVICE_SID)
        .verifications.create({ to, channel: 'sms' });
      this.logger.log(
        `Verify SMS started status=${String(result?.status ?? '')} to=${this.maskPhone(to)}`,
      );
    } catch (err) {
      const anyErr = err as any;
      const code = anyErr?.code ?? anyErr?.status;
      const message = anyErr?.message ?? String(err);
      this.logger.error(`Twilio Verify start error code=${code ?? 'unknown'} message=${message}`);
      throw err;
    }
  }

  private async checkVerifyCode(to: string, code: string) {
    const env = this.getEnv();
    if (!env.TWILIO_ACCOUNT_SID || !env.TWILIO_AUTH_TOKEN || !env.TWILIO_VERIFY_SERVICE_SID) {
      throw new Error(
        'Twilio Verify env vars missing (TWILIO_ACCOUNT_SID/TWILIO_AUTH_TOKEN/TWILIO_VERIFY_SERVICE_SID)',
      );
    }

    // Lazy import so local dev doesn't need to load Twilio.
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const twilio = require('twilio');
    const client = twilio(env.TWILIO_ACCOUNT_SID, env.TWILIO_AUTH_TOKEN);

    this.logger.log(`Checking Verify code to=${this.maskPhone(to)} service=VA...`);

    try {
      const result = await client.verify.v2
        .services(env.TWILIO_VERIFY_SERVICE_SID)
        .verificationChecks.create({ to, code });
      const status = String(result?.status ?? '');
      this.logger.log(`Verify check status=${status} to=${this.maskPhone(to)}`);
      return status === 'approved';
    } catch (err) {
      const anyErr = err as any;
      const code2 = anyErr?.code ?? anyErr?.status;
      const message = anyErr?.message ?? String(err);
      this.logger.error(`Twilio Verify check error code=${code2 ?? 'unknown'} message=${message}`);
      throw err;
    }
  }
}

