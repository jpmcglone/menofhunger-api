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

export type StripeConfig = {
  secretKey: string;
  webhookSecret: string;
  pricePremiumMonthly: string;
  pricePremiumPlusMonthly: string;
  /** Canonical frontend base URL used for redirect URLs (checkout/portal) and webhook click-through. */
  frontendBaseUrl: string;
};

export type EmailConfig = {
  provider: 'resend';
  apiKey: string;
  fromEmail: {
    default: string;
    notifications: string;
    support: string;
  };
};

export type MapboxConfig = {
  accessToken: string;
  geocodeTimeoutMs: number;
};

@Injectable()
export class AppConfigService {
  private readonly logger = new Logger(AppConfigService.name);

  constructor(private readonly config: ConfigService) {}

  private readBool(key: string, fallback: boolean): boolean {
    const raw = this.config.get<string>(key);
    if (raw == null) return fallback;
    const v = String(raw).trim().toLowerCase();
    if (!v) return fallback;
    if (['1', 'true', 'yes', 'on'].includes(v)) return true;
    if (['0', 'false', 'no', 'off'].includes(v)) return false;
    return fallback;
  }

  nodeEnv(): NodeEnv {
    return (this.config.get<string>('NODE_ENV') ?? 'development') as NodeEnv;
  }

  isProd(): boolean {
    return this.nodeEnv() === 'production';
  }

  redisUrl(): string {
    return (this.config.get<string>('REDIS_URL') ?? 'redis://localhost:6379').trim() || 'redis://localhost:6379';
  }

  runHttp(): boolean {
    return this.readBool('RUN_HTTP', true);
  }

  runSchedulers(): boolean {
    return this.readBool('RUN_SCHEDULERS', true);
  }

  runJobConsumers(): boolean {
    return this.readBool('RUN_JOB_CONSUMERS', true);
  }

  port(): number {
    const raw = this.config.get<string>('PORT') ?? '3001';
    const n = Number(raw);
    return Number.isFinite(n) ? n : 3001;
  }

  /** Number of connection retries on startup (default 20). */
  prismaConnectRetries(): number {
    const raw = this.config.get<string>('PRISMA_CONNECT_RETRIES') ?? '20';
    const n = Number(raw);
    return Number.isFinite(n) && n > 0 ? Math.floor(n) : 20;
  }

  /** Delay in ms between connection retries (default 500). */
  prismaConnectRetryDelayMs(): number {
    const raw = this.config.get<string>('PRISMA_CONNECT_RETRY_DELAY_MS') ?? '500';
    const n = Number(raw);
    return Number.isFinite(n) && n > 0 ? Math.floor(n) : 500;
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

  giphyApiKey(): string | null {
    const v = this.config.get<string>('GIPHY_API_KEY')?.trim() ?? '';
    return v ? v : null;
  }

  mapbox(): MapboxConfig | null {
    const accessToken = this.config.get<string>('MAPBOX_ACCESS_TOKEN')?.trim() ?? '';
    if (!accessToken) return null;
    const rawTimeout = this.config.get<string>('MAPBOX_GEOCODE_TIMEOUT_MS')?.trim() ?? '';
    const n = Number(rawTimeout);
    const geocodeTimeoutMs = Number.isFinite(n) && n > 0 ? Math.floor(n) : 4000;
    return { accessToken, geocodeTimeoutMs };
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

  private readPositiveInt(key: string, fallback: number) {
    const raw = this.config.get<string>(key) ?? '';
    const n = Number(raw);
    return Number.isFinite(n) && n > 0 ? Math.floor(n) : fallback;
  }

  rateLimitAuthStartTtlSeconds(): number {
    return this.readPositiveInt('RATE_LIMIT_AUTH_START_TTL_SECONDS', 60);
  }
  rateLimitAuthStartLimit(): number {
    return this.readPositiveInt('RATE_LIMIT_AUTH_START_LIMIT', 8);
  }

  rateLimitAuthVerifyTtlSeconds(): number {
    return this.readPositiveInt('RATE_LIMIT_AUTH_VERIFY_TTL_SECONDS', 60);
  }
  rateLimitAuthVerifyLimit(): number {
    return this.readPositiveInt('RATE_LIMIT_AUTH_VERIFY_LIMIT', 20);
  }

  rateLimitPostCreateTtlSeconds(): number {
    return this.readPositiveInt('RATE_LIMIT_POST_CREATE_TTL_SECONDS', 60);
  }
  rateLimitPostCreateLimit(): number {
    return this.readPositiveInt('RATE_LIMIT_POST_CREATE_LIMIT', 30);
  }

  rateLimitInteractTtlSeconds(): number {
    return this.readPositiveInt('RATE_LIMIT_INTERACT_TTL_SECONDS', 60);
  }
  rateLimitInteractLimit(): number {
    return this.readPositiveInt('RATE_LIMIT_INTERACT_LIMIT', 180);
  }

  rateLimitUploadTtlSeconds(): number {
    return this.readPositiveInt('RATE_LIMIT_UPLOAD_TTL_SECONDS', 60);
  }
  rateLimitUploadLimit(): number {
    return this.readPositiveInt('RATE_LIMIT_UPLOAD_LIMIT', 60);
  }

  trustProxy(): boolean {
    const raw = this.config.get<string>('TRUST_PROXY') ?? '';
    const v = raw.trim().toLowerCase();
    return ['1', 'true', 'yes', 'on'].includes(v);
  }

  bodyJsonLimit(): string {
    return (this.config.get<string>('BODY_JSON_LIMIT') ?? '1mb').trim() || '1mb';
  }

  bodyUrlEncodedLimit(): string {
    return (this.config.get<string>('BODY_URLENCODED_LIMIT') ?? '25kb').trim() || '25kb';
  }

  requireCsrfOriginInProd(): boolean {
    const raw = this.config.get<string>('REQUIRE_CSRF_ORIGIN_IN_PROD') ?? '';
    const v = raw.trim().toLowerCase();
    // default true
    if (!v) return true;
    return ['1', 'true', 'yes', 'on'].includes(v);
  }

  logRequests(): boolean {
    // Only meaningful in non-prod; still allow explicit opt-in elsewhere if needed.
    const raw = this.config.get<string>('LOG_REQUESTS') ?? '';
    const v = raw.trim().toLowerCase();
    return ['1', 'true', 'yes', 'on'].includes(v);
  }

  logStartupInfo(): boolean {
    const raw = this.config.get<string>('LOG_STARTUP_INFO') ?? '';
    const v = raw.trim().toLowerCase();
    return ['1', 'true', 'yes', 'on'].includes(v);
  }

  /** Minutes with no activity ping before marking user idle (show clock). */
  presenceIdleAfterMinutes(): number {
    return this.readPositiveInt('PRESENCE_IDLE_AFTER_MINUTES', 3);
  }

  /** If user stays idle this many minutes, disconnect them (socket closed, considered offline). */
  presenceIdleDisconnectMinutes(): number {
    return this.readPositiveInt('PRESENCE_IDLE_DISCONNECT_MINUTES', 15);
  }

  /** Web Push VAPID public key (for browser push subscriptions). Generate: npx web-push generate-vapid-keys */
  vapidPublicKey(): string | null {
    const v = this.config.get<string>('VAPID_PUBLIC_KEY')?.trim() ?? '';
    return v ? v : null;
  }

  /** Web Push VAPID private key. Required to send push; if unset, subscriptions are stored but no push is sent. */
  vapidPrivateKey(): string | null {
    const v = this.config.get<string>('VAPID_PRIVATE_KEY')?.trim() ?? '';
    return v ? v : null;
  }

  /** True if both VAPID keys are set (push can be sent). */
  vapidConfigured(): boolean {
    return Boolean(this.vapidPublicKey() && this.vapidPrivateKey());
  }

  /** Base URL for push notification click-through (canonical frontend). If unset, first ALLOWED_ORIGINS entry is used. */
  pushFrontendBaseUrl(): string | null {
    const v = this.config.get<string>('PUSH_FRONTEND_BASE_URL')?.trim() ?? '';
    return v ? v : null;
  }

  /** Canonical frontend base URL. Prefer explicit PUSH_FRONTEND_BASE_URL, else first allowed origin. */
  frontendBaseUrl(): string | null {
    const explicit = this.pushFrontendBaseUrl();
    if (explicit) return explicit;
    const first = this.allowedOrigins()[0];
    return first ? first : null;
  }

  stripe(): StripeConfig | null {
    const secretKey = this.config.get<string>('STRIPE_SECRET_KEY')?.trim() ?? '';
    const webhookSecret = this.config.get<string>('STRIPE_WEBHOOK_SECRET')?.trim() ?? '';
    const pricePremiumMonthly = this.config.get<string>('STRIPE_PRICE_PREMIUM_MONTHLY')?.trim() ?? '';
    const pricePremiumPlusMonthly = this.config.get<string>('STRIPE_PRICE_PREMIUM_PLUS_MONTHLY')?.trim() ?? '';
    const frontendBaseUrl = this.frontendBaseUrl()?.trim() ?? '';

    if (!secretKey || !webhookSecret || !pricePremiumMonthly || !pricePremiumPlusMonthly || !frontendBaseUrl) return null;
    return { secretKey, webhookSecret, pricePremiumMonthly, pricePremiumPlusMonthly, frontendBaseUrl };
  }

  email(): EmailConfig | null {
    const resendApiKey = this.config.get<string>('RESEND_API_KEY')?.trim() ?? '';
    const resendFromDefault = this.config.get<string>('RESEND_FROM_EMAIL')?.trim() ?? '';
    const resendFromNotifications = this.config.get<string>('RESEND_FROM_NOTIFICATIONS_EMAIL')?.trim() ?? '';
    const resendFromSupport = this.config.get<string>('RESEND_FROM_SUPPORT_EMAIL')?.trim() ?? '';

    const fallback = resendFromDefault;
    const notifications = resendFromNotifications || fallback;
    const support = resendFromSupport || fallback;
    const effectiveDefault = fallback || notifications || support;

    if (resendApiKey && effectiveDefault) {
      return {
        provider: 'resend',
        apiKey: resendApiKey,
        fromEmail: {
          default: effectiveDefault,
          notifications: notifications || effectiveDefault,
          support: support || effectiveDefault,
        },
      };
    }
    return null;
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
      GIPHY_API_KEY: this.config.get<string>('GIPHY_API_KEY') as Env['GIPHY_API_KEY'],
      MAPBOX_ACCESS_TOKEN: this.config.get<string>('MAPBOX_ACCESS_TOKEN') as Env['MAPBOX_ACCESS_TOKEN'],
      MAPBOX_GEOCODE_TIMEOUT_MS: this.config.get<string>('MAPBOX_GEOCODE_TIMEOUT_MS') as Env['MAPBOX_GEOCODE_TIMEOUT_MS'],
      RATE_LIMIT_TTL_SECONDS: this.config.get<string>('RATE_LIMIT_TTL_SECONDS') as Env['RATE_LIMIT_TTL_SECONDS'],
      RATE_LIMIT_LIMIT: this.config.get<string>('RATE_LIMIT_LIMIT') as Env['RATE_LIMIT_LIMIT'],
      RATE_LIMIT_AUTH_START_TTL_SECONDS: this.config.get<string>(
        'RATE_LIMIT_AUTH_START_TTL_SECONDS',
      ) as Env['RATE_LIMIT_AUTH_START_TTL_SECONDS'],
      RATE_LIMIT_AUTH_START_LIMIT: this.config.get<string>('RATE_LIMIT_AUTH_START_LIMIT') as Env['RATE_LIMIT_AUTH_START_LIMIT'],
      RATE_LIMIT_AUTH_VERIFY_TTL_SECONDS: this.config.get<string>(
        'RATE_LIMIT_AUTH_VERIFY_TTL_SECONDS',
      ) as Env['RATE_LIMIT_AUTH_VERIFY_TTL_SECONDS'],
      RATE_LIMIT_AUTH_VERIFY_LIMIT: this.config.get<string>('RATE_LIMIT_AUTH_VERIFY_LIMIT') as Env['RATE_LIMIT_AUTH_VERIFY_LIMIT'],
      RATE_LIMIT_POST_CREATE_TTL_SECONDS: this.config.get<string>(
        'RATE_LIMIT_POST_CREATE_TTL_SECONDS',
      ) as Env['RATE_LIMIT_POST_CREATE_TTL_SECONDS'],
      RATE_LIMIT_POST_CREATE_LIMIT: this.config.get<string>(
        'RATE_LIMIT_POST_CREATE_LIMIT',
      ) as Env['RATE_LIMIT_POST_CREATE_LIMIT'],
      RATE_LIMIT_INTERACT_TTL_SECONDS: this.config.get<string>(
        'RATE_LIMIT_INTERACT_TTL_SECONDS',
      ) as Env['RATE_LIMIT_INTERACT_TTL_SECONDS'],
      RATE_LIMIT_INTERACT_LIMIT: this.config.get<string>('RATE_LIMIT_INTERACT_LIMIT') as Env['RATE_LIMIT_INTERACT_LIMIT'],
      RATE_LIMIT_UPLOAD_TTL_SECONDS: this.config.get<string>('RATE_LIMIT_UPLOAD_TTL_SECONDS') as Env['RATE_LIMIT_UPLOAD_TTL_SECONDS'],
      RATE_LIMIT_UPLOAD_LIMIT: this.config.get<string>('RATE_LIMIT_UPLOAD_LIMIT') as Env['RATE_LIMIT_UPLOAD_LIMIT'],
      TRUST_PROXY: this.config.get<string>('TRUST_PROXY') as Env['TRUST_PROXY'],
      BODY_JSON_LIMIT: this.config.get<string>('BODY_JSON_LIMIT') as Env['BODY_JSON_LIMIT'],
      BODY_URLENCODED_LIMIT: this.config.get<string>('BODY_URLENCODED_LIMIT') as Env['BODY_URLENCODED_LIMIT'],
      REQUIRE_CSRF_ORIGIN_IN_PROD: this.config.get<string>(
        'REQUIRE_CSRF_ORIGIN_IN_PROD',
      ) as Env['REQUIRE_CSRF_ORIGIN_IN_PROD'],
      STRIPE_SECRET_KEY: this.config.get<string>('STRIPE_SECRET_KEY') as Env['STRIPE_SECRET_KEY'],
      STRIPE_WEBHOOK_SECRET: this.config.get<string>('STRIPE_WEBHOOK_SECRET') as Env['STRIPE_WEBHOOK_SECRET'],
      STRIPE_PRICE_PREMIUM_MONTHLY: this.config.get<string>('STRIPE_PRICE_PREMIUM_MONTHLY') as Env['STRIPE_PRICE_PREMIUM_MONTHLY'],
      STRIPE_PRICE_PREMIUM_PLUS_MONTHLY: this.config.get<string>(
        'STRIPE_PRICE_PREMIUM_PLUS_MONTHLY',
      ) as Env['STRIPE_PRICE_PREMIUM_PLUS_MONTHLY'],
      RESEND_API_KEY: this.config.get<string>('RESEND_API_KEY') as Env['RESEND_API_KEY'],
      RESEND_FROM_EMAIL: this.config.get<string>('RESEND_FROM_EMAIL') as Env['RESEND_FROM_EMAIL'],
      RESEND_FROM_NOTIFICATIONS_EMAIL: this.config.get<string>(
        'RESEND_FROM_NOTIFICATIONS_EMAIL',
      ) as Env['RESEND_FROM_NOTIFICATIONS_EMAIL'],
      RESEND_FROM_SUPPORT_EMAIL: this.config.get<string>('RESEND_FROM_SUPPORT_EMAIL') as Env['RESEND_FROM_SUPPORT_EMAIL'],
    };
  }
}

