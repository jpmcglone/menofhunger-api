import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { Env } from './env';

export type NodeEnv = 'development' | 'test' | 'production';

export type TwilioVerifyConfig = {
  accountSid: string;
  authToken: string;
  verifyServiceSid: string;
};

export type R2Config = {
  accountId: string;
  accessKeyId: string;
  secretAccessKey: string;
  bucket: string;
  // Optional: used by clients to render public asset URLs (often set in WWW env instead).
  publicBaseUrl?: string;
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

  r2(): R2Config | null {
    const accountId = this.config.get<string>('R2_ACCOUNT_ID')?.trim() ?? '';
    const accessKeyId = this.config.get<string>('R2_ACCESS_KEY_ID')?.trim() ?? '';
    const secretAccessKey = this.config.get<string>('R2_SECRET_ACCESS_KEY')?.trim() ?? '';
    const bucket = this.config.get<string>('R2_BUCKET')?.trim() ?? '';
    const publicBaseUrl = this.config.get<string>('R2_PUBLIC_BASE_URL')?.trim() ?? '';

    // Uploads only require S3-compatible credentials + bucket. Public base URL is optional.
    if (!accountId || !accessKeyId || !secretAccessKey || !bucket) return null;
    const cfg: R2Config = { accountId, accessKeyId, secretAccessKey, bucket };
    if (publicBaseUrl) cfg.publicBaseUrl = publicBaseUrl;
    // IMPORTANT:
    // Cloudflare public bucket URLs are NOT always derivable from bucket/account id.
    // When using the Cloudflare-managed "Public Development URL", the base looks like:
    //   https://pub-<random>.r2.dev
    // So if R2_PUBLIC_BASE_URL isn't provided, we cannot safely guess a working URL.
    if (!cfg.publicBaseUrl) {
      this.logger.warn('R2_PUBLIC_BASE_URL is not set; public asset URLs will be null.');
    }
    return cfg;
  }

  rateLimitTtlSeconds(): number {
    const raw = this.config.get<string>('RATE_LIMIT_TTL_SECONDS') ?? '';
    const n = Number(raw);
    return Number.isFinite(n) && n > 0 ? n : 60;
  }

  rateLimitLimit(): number {
    const raw = this.config.get<string>('RATE_LIMIT_LIMIT') ?? '';
    const n = Number(raw);
    // Pretty generous default.
    return Number.isFinite(n) && n > 0 ? n : 600;
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
      R2_ACCOUNT_ID: this.config.get<string>('R2_ACCOUNT_ID') as Env['R2_ACCOUNT_ID'],
      R2_ACCESS_KEY_ID: this.config.get<string>('R2_ACCESS_KEY_ID') as Env['R2_ACCESS_KEY_ID'],
      R2_SECRET_ACCESS_KEY: this.config.get<string>('R2_SECRET_ACCESS_KEY') as Env['R2_SECRET_ACCESS_KEY'],
      R2_BUCKET: this.config.get<string>('R2_BUCKET') as Env['R2_BUCKET'],
      R2_PUBLIC_BASE_URL: this.config.get<string>('R2_PUBLIC_BASE_URL') as Env['R2_PUBLIC_BASE_URL'],
      RATE_LIMIT_TTL_SECONDS: this.config.get<string>('RATE_LIMIT_TTL_SECONDS') as Env['RATE_LIMIT_TTL_SECONDS'],
      RATE_LIMIT_LIMIT: this.config.get<string>('RATE_LIMIT_LIMIT') as Env['RATE_LIMIT_LIMIT'],
    };
  }
}

