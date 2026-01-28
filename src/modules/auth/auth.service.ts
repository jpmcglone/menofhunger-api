import { BadRequestException, Inject, Injectable, Logger, ServiceUnavailableException } from '@nestjs/common';
import type { Response } from 'express';
import { PrismaService } from '../prisma/prisma.service';
import { AppConfigService } from '../app/app-config.service';
import {
  AUTH_COOKIE_NAME,
  OTP_RESEND_SECONDS,
  SESSION_TTL_DAYS,
} from './auth.constants';
import { hmacSha256Hex, randomSessionToken } from './auth.utils';
import { OTP_PROVIDER } from './otp/otp-provider.token';
import type { OtpProvider } from './otp/otp-provider';
import { toUserDto } from '../users/user.dto';

@Injectable()
export class AuthService {
  private readonly logger = new Logger(AuthService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly appConfig: AppConfigService,
    @Inject(OTP_PROVIDER) private readonly otpProvider: OtpProvider,
  ) {}

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
      return { retryAfterSeconds };
    }

    const isProd = this.appConfig.isProd();
    const disableTwilioInDev = !isProd && this.appConfig.disableTwilioInDev();
    const hasTwilioVerify = Boolean(this.appConfig.twilioVerify());

    this.logger.log(
      `startPhoneAuth phone=${this.maskPhone(phone)} env=${this.appConfig.nodeEnv()} twilio=${
        disableTwilioInDev ? 'disabled_in_dev' : hasTwilioVerify ? 'verify_enabled' : 'not_configured'
      }`,
    );

    if (isProd && !hasTwilioVerify) {
      throw new ServiceUnavailableException('SMS login is not configured yet. Please try again later.');
    }

    if (!disableTwilioInDev && hasTwilioVerify) {
      try {
        await this.otpProvider.start(phone);
      } catch (err) {
        this.logger.error(`Twilio Verify start failed for phone=${this.maskPhone(phone)}`, (err as Error)?.stack);
        throw new ServiceUnavailableException('SMS login is not configured yet. Please try again later.');
      }
    } else {
      this.logger.warn(`Skipping SMS send for phone=${this.maskPhone(phone)}`);
    }

    // Store a row to enforce resend cooldown and represent "an active code exists".
    // We don't store/know the Verify code, so hash a random value.
    const codeHash = hmacSha256Hex(this.appConfig.otpHmacSecret(), `${phone}:${randomSessionToken()}`);
    const expiresAt = new Date(now.getTime() + 10 * 60_000);
    const resendAfterAt = new Date(now.getTime() + OTP_RESEND_SECONDS * 1000);

    await this.prisma.phoneOtp.create({
      data: {
        phone,
        codeHash,
        expiresAt,
        resendAfterAt,
      },
    });

    return { retryAfterSeconds: OTP_RESEND_SECONDS };
  }

  async phoneExists(phone: string): Promise<boolean> {
    const existing = await this.prisma.user.findUnique({
      where: { phone },
      select: { id: true },
    });
    return Boolean(existing);
  }

  async verifyPhoneCode(phone: string, code: string, res: Response) {
    const now = new Date();
    const isProd = this.appConfig.isProd();
    const disableTwilioInDev = !isProd && this.appConfig.disableTwilioInDev();
    const hasTwilioVerify = Boolean(this.appConfig.twilioVerify());

    const isDevBypass = !isProd && code === '000000';

    // In dev, allow bypass even if /auth/phone/start was never called.
    // (Still safe: production does not allow this path.)
    const otp = await this.prisma.phoneOtp.findFirst({
      where: {
        phone,
        consumedAt: null,
        expiresAt: { gt: now },
      },
      orderBy: { createdAt: 'desc' },
    });

    if (!otp && !isDevBypass) {
      throw new BadRequestException('No active code found. Please resend.');
    }

    if (!isDevBypass) {
      if (!disableTwilioInDev && hasTwilioVerify) {
        try {
          const ok = await this.otpProvider.check(phone, code);
          if (!ok) throw new BadRequestException('Invalid code. Please try again.');
        } catch (err) {
          if (err instanceof BadRequestException) throw err;
          this.logger.error(`Twilio Verify check failed for phone=${this.maskPhone(phone)}`, (err as Error)?.stack);
          throw new ServiceUnavailableException('SMS login is not configured yet. Please try again later.');
        }
      } else {
        throw new ServiceUnavailableException('SMS login is not configured yet. Please try again later.');
      }
    }

    if (otp) {
      await this.prisma.phoneOtp.update({
        where: { id: otp.id },
        data: { consumedAt: now },
      });
    }

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

    const publicBaseUrl = this.appConfig.r2()?.publicBaseUrl ?? null;
    return {
      isNewUser,
      user: toUserDto(user, publicBaseUrl),
      sessionId: session.id,
    };
  }

  async meFromSessionToken(token: string | undefined) {
    if (!token) return null;
    const now = new Date();
    const tokenHash = hmacSha256Hex(this.appConfig.sessionHmacSecret(), token);

    const session = await this.prisma.session.findFirst({
      where: {
        tokenHash,
        revokedAt: null,
        expiresAt: { gt: now },
      },
      include: { user: true },
    });

    if (!session) return null;
    return toUserDto(session.user, this.appConfig.r2()?.publicBaseUrl ?? null);
  }

  async logout(token: string | undefined, res: Response) {
    if (token) {
      const tokenHash = hmacSha256Hex(this.appConfig.sessionHmacSecret(), token);
      await this.prisma.session.updateMany({
        where: { tokenHash, revokedAt: null },
        data: { revokedAt: new Date() },
      });
    }

    this.clearAuthCookie(res);
    return { success: true };
  }

  private cookieOptions(expires: Date) {
    const isProd = this.appConfig.isProd();
    const domain = isProd ? this.appConfig.cookieDomain() ?? '.menofhunger.com' : undefined;
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
    const isProd = this.appConfig.isProd();
    const domain = isProd ? this.appConfig.cookieDomain() ?? '.menofhunger.com' : undefined;
    res.clearCookie(AUTH_COOKIE_NAME, { path: '/', domain });
  }

  private async createSessionAndSetCookie(userId: string, res: Response) {
    const token = randomSessionToken();
    const tokenHash = hmacSha256Hex(this.appConfig.sessionHmacSecret(), token);

    const now = new Date();
    const expiresAt = new Date(now.getTime() + SESSION_TTL_DAYS * 24 * 60 * 60_000);

    const session = await this.prisma.session.create({
      data: { userId, tokenHash, expiresAt },
    });

    this.setAuthCookie(token, expiresAt, res);
    return session;
  }
}

