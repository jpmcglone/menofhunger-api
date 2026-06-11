import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { Env } from './env';

export type NodeEnv = 'development' | 'test' | 'production';

/**
 * Adds a display name to a bare email address if one isn't already present.
 * e.g. "noreply@menofhunger.com" → "Men of Hunger <noreply@menofhunger.com>"
 * Already-formatted strings like "Men of Hunger <...>" are left unchanged.
 */
function withDisplayName(email: string, name: string): string {
  if (!email || email.includes('<')) return email;
  return `${name} <${email}>`;
}

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

export type MarvBotConfig = {
  enabled: boolean;
  /** When set, prefer this id over username lookup. */
  userId: string | null;
  username: string;
  displayName: string;
  bio: string;
  phone: string;
};

export type MarvOpenAIConfig = {
  apiKey: string;
  /** OpenAI Stored Prompt id (e.g. "pmpt_..."). When unset, OpenAI calls are short-circuited. */
  promptId: string | null;
  fastModel: string;
  regularModel: string;
  smartModel: string;
  /** When true, `web_search_preview` is added to Marv requests for qualifying modes. */
  webSearchEnabled: boolean;
  /** Modes (subset of 'fast' | 'regular' | 'smart') that may use web search. */
  webSearchModes: string[];
  /** max_output_tokens override when web search is active — must be larger than the base limit. */
  webSearchMaxOutputTokens: number;
  /** When true, image inputs (input_image parts) are sent to OpenAI for qualifying modes. */
  visionEnabled: boolean;
  /** Modes that may receive image inputs. Default regular,smart. */
  visionModes: string[];
  /** Max images per turn (caps both selection logic and input_image parts). Default 4. */
  visionMaxImagesPerTurn: number;
};

export type MarvCreditConfig = {
  monthlyCredits: number;
  maxCredits: number;
  creditsPerDay: number;
  fastCost: number;
  regularCost: number;
  smartCost: number;
  /** Extra credits charged per web search call Marv makes within a single reply. */
  webSearchCreditCost: number;
  /** Extra credits charged per image attached to a Marv request. */
  visionCreditCostPerImage: number;
  /** Extra credits charged per fetch_url_content tool call Marv makes within a single reply. */
  urlFetchCreditCost: number;
};

export type MarvLimitsConfig = {
  publicMaxInputTokens: number;
  privateMaxInputTokens: number;
  maxOutputTokens: number;
  publicMaxPerUserPerHour: number;
  publicMaxPerUserPerDay: number;
  /** Max successful Marv replies to the same (thread, user) within `publicThreadBurstWindowSeconds`. */
  publicThreadBurstLimit: number;
  /** Sliding window (seconds) over which `publicThreadBurstLimit` is enforced. */
  publicThreadBurstWindowSeconds: number;
  privateMaxPerUserPerDay: number;
  privateMaxPer10Minutes: number;
  /**
   * BullMQ worker concurrency for the dedicated Marv queue. AI replies are I/O-bound
   * (waiting on OpenAI), so values much greater than 1 are safe. Default 8 — sized for
   * ~50–200 simultaneous premium users. Tune via `MARV_QUEUE_CONCURRENCY`.
   */
  queueConcurrency: number;
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

  databaseUrlIsSet(): boolean {
    return Boolean(this.config.get<string>('DATABASE_URL')?.trim());
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

  /** Enable Prisma slow query logging (default: on in dev/test, off in prod). */
  prismaLogSlowQueries(): boolean {
    const fallback = this.nodeEnv() !== 'production';
    return this.readBool('PRISMA_LOG_SLOW_QUERIES', fallback);
  }

  /** Slow query threshold in ms (default 200). */
  prismaSlowQueryMs(): number {
    return this.readPositiveInt('PRISMA_SLOW_QUERY_MS', 200);
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

  /**
   * APNs (native iOS push) configuration. Token-based auth with a .p8 key from the
   * Apple Developer portal. APNS_PRIVATE_KEY may contain literal "\n" sequences
   * (common in env-var storage) — they are normalized to real newlines here.
   * If any value is missing, APNs is disabled and device tokens are stored but unused.
   */
  apns(): { keyId: string; teamId: string; privateKey: string; bundleId: string } | null {
    const keyId = this.config.get<string>('APNS_KEY_ID')?.trim() ?? '';
    const teamId = this.config.get<string>('APNS_TEAM_ID')?.trim() ?? '';
    const rawKey = this.config.get<string>('APNS_PRIVATE_KEY') ?? '';
    const privateKey = rawKey.replace(/\\n/g, '\n').trim();
    const bundleId = this.config.get<string>('APNS_BUNDLE_ID')?.trim() ?? '';
    if (!keyId || !teamId || !privateKey || !bundleId) return null;
    return { keyId, teamId, privateKey, bundleId };
  }

  /** True if all APNS_* env vars are set (native iOS push can be sent). */
  apnsConfigured(): boolean {
    return this.apns() !== null;
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
          default: withDisplayName(effectiveDefault, 'Men of Hunger'),
          notifications: withDisplayName(notifications || effectiveDefault, 'Men of Hunger'),
          support: withDisplayName(support || effectiveDefault, 'Men of Hunger'),
        },
      };
    }
    return null;
  }

  slackWebhookUrl(): string | null {
    const v = this.config.get<string>('SLACK_WEBHOOK_URL')?.trim() ?? '';
    return v ? v : null;
  }

  posthogApiKey(): string | null {
    const v = this.config.get<string>('POSTHOG_API_KEY')?.trim() ?? '';
    return v ? v : null;
  }

  posthogHost(): string {
    return (this.config.get<string>('POSTHOG_HOST')?.trim() || 'https://us.i.posthog.com').trim();
  }

  // ─── Marv (AI helper) ────────────────────────────────────────────────────

  marvBot(): MarvBotConfig {
    const enabled = this.readBool('MARV_ENABLED', true);
    const userId = this.config.get<string>('MARV_USER_ID')?.trim() || null;
    const username = this.config.get<string>('MARV_USERNAME')?.trim() || 'marv';
    const displayName = this.config.get<string>('MARV_DISPLAY_NAME')?.trim() || 'Marv';
    const bio =
      this.config.get<string>('MARV_BIO')?.trim() ||
      'AI helper for Men of Hunger. Brief. Bible-conscious. Mention me to ask.';
    const phone = this.config.get<string>('MARV_PHONE')?.trim() || '+10000000001';
    return { enabled, userId, username, displayName, bio, phone };
  }

  marvOpenAI(): MarvOpenAIConfig {
    const apiKey = this.config.get<string>('OPENAI_API_KEY')?.trim() ?? '';
    const promptId = this.config.get<string>('OPENAI_MARV_PROMPT_ID')?.trim() || null;
    const fastModel = this.config.get<string>('OPENAI_MARV_FAST_MODEL')?.trim() || 'gpt-5.4-nano';
    const regularModel = this.config.get<string>('OPENAI_MARV_REGULAR_MODEL')?.trim() || 'gpt-5.4-mini';
    const smartModel = this.config.get<string>('OPENAI_MARV_SMART_MODEL')?.trim() || 'gpt-5.5';
    // Web search is ON by default. Set MARV_WEB_SEARCH_ENABLED=false to disable.
    const webSearchEnabled = this.readBool('MARV_WEB_SEARCH_ENABLED', true);
    // Comma-separated list of modes that may use web search. Defaults to regular,smart only —
    // fast (gpt-5.4-nano) exhausts its token budget on search processing before producing any text.
    const webSearchModesRaw = this.config.get<string>('MARV_WEB_SEARCH_MODES')?.trim() || 'regular,smart';
    const webSearchModes = webSearchModesRaw.split(',').map((s) => s.trim().toLowerCase()).filter(Boolean);
    // When web search is active, use a larger output-token budget so the model has room to
    // both process search results AND write a reply. Default 4096; tune with MARV_WEB_SEARCH_MAX_OUTPUT_TOKENS.
    const webSearchMaxOutputTokens = this.readPositiveInt('MARV_WEB_SEARCH_MAX_OUTPUT_TOKENS', 4096);
    // Vision is ON by default. Set MARV_VISION_ENABLED=false to disable.
    const visionEnabled = this.readBool('MARV_VISION_ENABLED', true);
    // All three model tiers support image inputs. Previously only regular,smart was default,
    // which meant auto-routed queries landing on fast would silently drop images and Marv
    // would claim he can't see them. fast (gpt-5.4-nano) handles vision fine; the token-budget
    // concern only applies to web search (see webSearchModes).
    const visionModesRaw = this.config.get<string>('MARV_VISION_MODES')?.trim() || 'fast,regular,smart';
    const visionModes = visionModesRaw.split(',').map((s) => s.trim().toLowerCase()).filter(Boolean);
    const visionMaxImagesPerTurn = this.readPositiveInt('MARV_VISION_MAX_IMAGES_PER_TURN', 4);
    return { apiKey, promptId, fastModel, regularModel, smartModel, webSearchEnabled, webSearchModes, webSearchMaxOutputTokens, visionEnabled, visionModes, visionMaxImagesPerTurn };
  }

  marvCredits(): MarvCreditConfig {
    return {
      monthlyCredits: this.readPositiveInt('MARV_MONTHLY_CREDITS', 1200),
      maxCredits: this.readPositiveInt('MARV_MAX_CREDITS', 1500),
      creditsPerDay: this.readPositiveInt('MARV_CREDITS_PER_DAY', 40),
      fastCost: this.readPositiveInt('MARV_FAST_COST', 1),
      regularCost: this.readPositiveInt('MARV_REGULAR_COST', 2),
      // Smart uses gpt-5.5 (~$0.02/req) vs regular gpt-5.4-mini (~$0.004/req) — bumped to 5
      // so the per-credit USD cost is roughly even with regular mode.
      smartCost: this.readPositiveInt('MARV_SMART_COST', 5),
      // Each web_search_preview call costs ~$0.03 (OpenAI pricing). Bumped to 4 so the
      // per-credit cost aligns with regular mode instead of being ~7x subsidized.
      webSearchCreditCost: this.readPositiveInt('MARV_WEB_SEARCH_CREDIT_COST', 4),
      // Extra credits per image sent to the vision model (~$0.002/image on gpt-5.4-mini).
      visionCreditCostPerImage: this.readPositiveInt('MARV_VISION_CREDIT_COST_PER_IMAGE', 2),
      // Extra credits per URL fetched via Jina Reader. Jina's public endpoint is free-tier,
      // so 1 credit per fetch keeps it cheap while still accounting for the network overhead.
      urlFetchCreditCost: this.readPositiveInt('MARV_URL_FETCH_CREDIT_COST', 1),
    };
  }

  marvLimits(): MarvLimitsConfig {
    return {
      publicMaxInputTokens: this.readPositiveInt('MARV_PUBLIC_MAX_INPUT_TOKENS', 8000),
      privateMaxInputTokens: this.readPositiveInt('MARV_PRIVATE_MAX_INPUT_TOKENS', 4000),
      // 1024 gives reasoning models (gpt-5.5, o-series) room to think before producing
      // visible text. The actual reply is kept short by the system prompt, so in
      // practice output_tokens land in the 50-120 range — but the cap must be high
      // enough that thinking tokens don't exhaust the budget before any text is emitted.
      // Override with MARV_MAX_OUTPUT_TOKENS in .env if you need to tune it.
      maxOutputTokens: this.readPositiveInt('MARV_MAX_OUTPUT_TOKENS', 1024),
      publicMaxPerUserPerHour: this.readPositiveInt('MARV_PUBLIC_MAX_PER_USER_PER_HOUR', 10),
      publicMaxPerUserPerDay: this.readPositiveInt('MARV_PUBLIC_MAX_PER_USER_PER_DAY', 30),
      publicThreadBurstLimit: this.readPositiveInt('MARV_PUBLIC_THREAD_BURST_LIMIT', 3),
      publicThreadBurstWindowSeconds: this.readPositiveInt('MARV_PUBLIC_THREAD_BURST_WINDOW_SECONDS', 60),
      privateMaxPerUserPerDay: this.readPositiveInt('MARV_PRIVATE_MAX_PER_USER_PER_DAY', 60),
      privateMaxPer10Minutes: this.readPositiveInt('MARV_PRIVATE_MAX_PER_10_MIN', 10),
      queueConcurrency: this.readPositiveInt('MARV_QUEUE_CONCURRENCY', 8),
    };
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

