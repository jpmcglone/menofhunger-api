import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { Env } from './env';

export type NodeEnv = 'development' | 'test' | 'production';

export type TwilioVerifyConfig = {
  accountSid: string;
  authToken: string;
  verifyServiceSid: string;
};

@Injectable()
export class AppConfigService {
  private readonly logger = new Logger(AppConfigService.name);

  constructor(private readonly config: ConfigService) {}

  nodeEnv(): NodeEnv {
    return (this.config.get<string>('NODE_ENV') ?? 'development') as NodeEnv;
  }

  isProd(): boolean {
    return this.nodeEnv() === 'production';
  }

  port(): number {
    const raw = this.config.get<string>('PORT') ?? '3001';
    const n = Number(raw);
    return Number.isFinite(n) ? n : 3001;
  }

  allowedOrigins(): string[] {
    const raw = this.config.get<string>('ALLOWED_ORIGINS') ?? '';
    return raw
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean);
  }

  isOriginAllowed(origin: string): boolean {
    return this.allowedOrigins().includes(origin);
  }

  logCorsBlocked(origin: string) {
    this.logger.warn(
      `CORS blocked origin: ${origin}. Allowed origins: ${this.allowedOrigins().join(', ') || '(none)'}`,
    );
  }

  otpHmacSecret(): string {
    // env schema provides defaults for non-prod
    return this.config.get<string>('OTP_HMAC_SECRET') ?? 'dev-otp-secret-change-me';
  }

  sessionHmacSecret(): string {
    // env schema provides defaults for non-prod
    return this.config.get<string>('SESSION_HMAC_SECRET') ?? 'dev-session-secret-change-me';
  }

  cookieDomain(): string | undefined {
    const v = this.config.get<string>('COOKIE_DOMAIN');
    return v?.trim() ? v.trim() : undefined;
  }

  disableTwilioInDev(): boolean {
    const raw = this.config.get<string>('DISABLE_TWILIO_IN_DEV') ?? '';
    const v = raw.trim().toLowerCase();
    return ['1', 'true', 'yes', 'on'].includes(v);
  }

  twilioVerify(): TwilioVerifyConfig | null {
    const accountSid = this.config.get<string>('TWILIO_ACCOUNT_SID')?.trim() ?? '';
    const authToken = this.config.get<string>('TWILIO_AUTH_TOKEN')?.trim() ?? '';
    const verifyServiceSid = this.config.get<string>('TWILIO_VERIFY_SERVICE_SID')?.trim() ?? '';

    if (!accountSid || !authToken || !verifyServiceSid) return null;
    return { accountSid, authToken, verifyServiceSid };
  }

  // Optional: typed access to full validated env object if needed later.
  envSnapshot(): Partial<Env> {
    return {
      NODE_ENV: this.config.get<string>('NODE_ENV') as Env['NODE_ENV'],
      PORT: this.config.get<string>('PORT') as Env['PORT'],
      DATABASE_URL: this.config.get<string>('DATABASE_URL') as Env['DATABASE_URL'],
      ALLOWED_ORIGINS: this.config.get<string>('ALLOWED_ORIGINS') as Env['ALLOWED_ORIGINS'],
      COOKIE_DOMAIN: this.config.get<string>('COOKIE_DOMAIN') as Env['COOKIE_DOMAIN'],
      DISABLE_TWILIO_IN_DEV: this.config.get<string>('DISABLE_TWILIO_IN_DEV') as Env['DISABLE_TWILIO_IN_DEV'],
      TWILIO_ACCOUNT_SID: this.config.get<string>('TWILIO_ACCOUNT_SID') as Env['TWILIO_ACCOUNT_SID'],
      TWILIO_AUTH_TOKEN: this.config.get<string>('TWILIO_AUTH_TOKEN') as Env['TWILIO_AUTH_TOKEN'],
      TWILIO_VERIFY_SERVICE_SID: this.config.get<string>('TWILIO_VERIFY_SERVICE_SID') as Env['TWILIO_VERIFY_SERVICE_SID'],
    };
  }
}

