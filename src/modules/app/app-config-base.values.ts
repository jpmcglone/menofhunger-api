import { Logger } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import type { AppleIapConfig, EmailConfig, NodeEnv, R2Config, StripeConfig, StravaConfig, TwilioVerifyConfig, XConfig } from "./app-config.types";

/** Adds a display name to a bare email if one isn't already present. */
function withDisplayName(email: string, name: string): string {
  if (!email || email.includes("<")) return email;
  return `${name} <${email}>`;
}

export class AppConfigBaseValues {
  protected readonly logger = new Logger("AppConfigService");

  constructor(protected readonly config: ConfigService) {}

  protected readBool(key: string, fallback: boolean): boolean {
    const raw = this.config.get<string>(key);
    if (raw == null) return fallback;
    const v = String(raw).trim().toLowerCase();
    if (!v) return fallback;
    if (["1", "true", "yes", "on"].includes(v)) return true;
    if (["0", "false", "no", "off"].includes(v)) return false;
    return fallback;
  }

  localBillingTestsEnabled(): boolean {
    try {
      return (
        this.config.get("MOH_LOCAL_BILLING_TESTS") === "1" &&
        this.nodeEnv() === "development" &&
        ["localhost", "127.0.0.1", "[::1]"].includes(
          new URL(this.databaseUrl()).hostname,
        )
      );
    } catch {
      return false;
    }
  }

  nodeEnv(): NodeEnv {
    return (this.config.get<string>("NODE_ENV") ?? "development") as NodeEnv;
  }

  isProd(): boolean {
    return this.nodeEnv() === "production";
  }

  redisUrl(): string {
    return (
      (
        this.config.get<string>("REDIS_URL") ?? "redis://localhost:6379"
      ).trim() || "redis://localhost:6379"
    );
  }

  databaseUrlIsSet(): boolean {
    return Boolean(this.config.get<string>("DATABASE_URL")?.trim());
  }

  databaseUrl(): string {
    return this.config.get<string>("DATABASE_URL")?.trim() ?? "";
  }

  runHttp(): boolean {
    return this.readBool("RUN_HTTP", true);
  }

  runSchedulers(): boolean {
    return this.readBool("RUN_SCHEDULERS", true);
  }

  runJobConsumers(): boolean {
    return this.readBool("RUN_JOB_CONSUMERS", true);
  }

  /**
   * In-flight side-effect jobs per worker (default 12).
   *
   * Side effects are I/O-bound (Postgres, Redis, APNs, Web Push), so concurrency well above 1
   * is the point — but it is capped because every in-flight job also holds Prisma connections.
   */
  sideEffectsQueueConcurrency(): number {
    const raw =
      this.config.get<string>("SIDE_EFFECTS_QUEUE_CONCURRENCY") ?? "12";
    const n = Number(raw);
    if (!Number.isFinite(n)) return 12;
    return Math.min(64, Math.max(1, Math.floor(n)));
  }

  port(): number {
    const raw = this.config.get<string>("PORT") ?? "3001";
    const n = Number(raw);
    return Number.isFinite(n) ? n : 3001;
  }

  /** Number of connection retries on startup (default 20). */
  prismaConnectRetries(): number {
    const raw = this.config.get<string>("PRISMA_CONNECT_RETRIES") ?? "20";
    const n = Number(raw);
    return Number.isFinite(n) && n > 0 ? Math.floor(n) : 20;
  }

  /** Delay in ms between connection retries (default 500). */
  prismaConnectRetryDelayMs(): number {
    const raw =
      this.config.get<string>("PRISMA_CONNECT_RETRY_DELAY_MS") ?? "500";
    const n = Number(raw);
    return Number.isFinite(n) && n > 0 ? Math.floor(n) : 500;
  }

  /** Enable Prisma slow query logging (default: on in dev/test, off in prod). */
  prismaLogSlowQueries(): boolean {
    const fallback = this.nodeEnv() !== "production";
    return this.readBool("PRISMA_LOG_SLOW_QUERIES", fallback);
  }

  /** Slow query threshold in ms (default 200). */
  prismaSlowQueryMs(): number {
    return this.readPositiveInt("PRISMA_SLOW_QUERY_MS", 200);
  }

  allowedOrigins(): string[] {
    const raw = this.config.get<string>("ALLOWED_ORIGINS") ?? "";
    return raw
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean);
  }

  isOriginAllowed(origin: string): boolean {
    return this.allowedOrigins().includes(origin);
  }

  logCorsBlocked(origin: string) {
    this.logger.warn(
      `CORS blocked origin: ${origin}. Allowed origins: ${this.allowedOrigins().join(", ") || "(none)"}`,
    );
  }

  otpHmacSecret(): string {
    // env schema provides defaults for non-prod
    return (
      this.config.get<string>("OTP_HMAC_SECRET") ?? "dev-otp-secret-change-me"
    );
  }

  sessionHmacSecret(): string {
    // env schema provides defaults for non-prod
    return (
      this.config.get<string>("SESSION_HMAC_SECRET") ??
      "dev-session-secret-change-me"
    );
  }

  mcpMemberDailyCalls(): number {
    return this.readPositiveInt("MCP_MEMBER_DAILY_CALLS", 200);
  }

  cookieDomain(): string | undefined {
    const v = this.config.get<string>("COOKIE_DOMAIN");
    return v?.trim() ? v.trim() : undefined;
  }

  browserHandoffBaseUrl(): string {
    const configured =
      this.config.get<string>("BROWSER_HANDOFF_BASE_URL")?.trim() ?? "";
    if (configured) return configured.replace(/\/+$/, "");
    return `http://localhost:${this.port()}/v1`;
  }

  disableTwilioInDev(): boolean {
    const raw = this.config.get<string>("DISABLE_TWILIO_IN_DEV") ?? "";
    const v = raw.trim().toLowerCase();
    return ["1", "true", "yes", "on"].includes(v);
  }

  /**
   * Returns the App Review bypass credentials when both APP_REVIEW_PHONE and APP_REVIEW_CODE
   * are set. When null, the bypass is disabled. Safe to call in any environment — the phone
   * number is only matched when the credentials are explicitly configured.
   */
  appReviewCredentials(): { phone: string; code: string } | null {
    const phone = this.config.get<string>("APP_REVIEW_PHONE")?.trim() ?? "";
    const code = this.config.get<string>("APP_REVIEW_CODE")?.trim() ?? "";
    if (!phone || !code) return null;
    return { phone, code };
  }

  twilioVerify(): TwilioVerifyConfig | null {
    const accountSid =
      this.config.get<string>("TWILIO_ACCOUNT_SID")?.trim() ?? "";
    const authToken =
      this.config.get<string>("TWILIO_AUTH_TOKEN")?.trim() ?? "";
    const verifyServiceSid =
      this.config.get<string>("TWILIO_VERIFY_SERVICE_SID")?.trim() ?? "";

    if (!accountSid || !authToken || !verifyServiceSid) return null;
    return { accountSid, authToken, verifyServiceSid };
  }

  /** Operational switch for SFU call admission. */
  callsSfuEnabled(): boolean {
    return this.config.get<string>("CALLS_SFU_ENABLED") === "true";
  }

  /** Conservative application reservation estimate; not a provider-enforced invoice cap. */
  callsBudgetBytesPerSecond(): number | null {
    const rate = Number(
      this.config.get<string>("CALLS_BUDGET_BYTES_PER_SECOND"),
    );
    return Number.isSafeInteger(rate) && rate > 0 ? rate : null;
  }

  cloudflareSfu(): { appId: string; secret: string } | null {
    const appId =
      this.config.get<string>("CLOUDFLARE_SFU_APP_ID")?.trim() ?? "";
    const secret =
      this.config.get<string>("CLOUDFLARE_SFU_APP_SECRET")?.trim() ?? "";
    if (!appId || !secret) return null;
    return { appId, secret };
  }

  r2(): R2Config | null {
    const accountId = this.config.get<string>("R2_ACCOUNT_ID")?.trim() ?? "";
    const accessKeyId =
      this.config.get<string>("R2_ACCESS_KEY_ID")?.trim() ?? "";
    const secretAccessKey =
      this.config.get<string>("R2_SECRET_ACCESS_KEY")?.trim() ?? "";
    const bucket = this.config.get<string>("R2_BUCKET")?.trim() ?? "";
    const publicBaseUrl =
      this.config.get<string>("R2_PUBLIC_BASE_URL")?.trim() ?? "";

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
      this.logger.warn(
        "R2_PUBLIC_BASE_URL is not set; public asset URLs will be null.",
      );
    }
    return cfg;
  }

  giphyApiKey(): string | null {
    const v = this.config.get<string>("GIPHY_API_KEY")?.trim() ?? "";
    return v ? v : null;
  }

  strava(): StravaConfig | null {
    const clientId = this.config.get<string>("STRAVA_CLIENT_ID")?.trim() ?? "";
    const clientSecret =
      this.config.get<string>("STRAVA_CLIENT_SECRET")?.trim() ?? "";
    const webhookVerifyToken =
      this.config.get<string>("STRAVA_WEBHOOK_VERIFY_TOKEN")?.trim() ?? "";
    if (!clientId || !clientSecret) return null;
    return {
      clientId,
      clientSecret,
      webhookVerifyToken: webhookVerifyToken || "moh-strava-verify",
    };
  }

  /** Key material for encrypting members' Pickax credentials; null disables the integration. */
  pickaxSecretEncryptionKey(): string | null {
    const v =
      this.config.get<string>("PICKAX_SECRET_ENCRYPTION_KEY")?.trim() ?? "";
    return v.length >= 32 ? v : null;
  }

  /** X OAuth app. Null disables the integration. */
  x(): XConfig | null {
    const clientId = this.config.get<string>("X_CLIENT_ID")?.trim() ?? "";
    const clientSecret =
      this.config.get<string>("X_CLIENT_SECRET")?.trim() ?? "";
    const encryptionKey =
      this.config.get<string>("X_TOKEN_ENCRYPTION_KEY")?.trim() ?? "";
    if (!clientId || !clientSecret || encryptionKey.length < 32) return null;
    const rawBudget = this.config.get<string | number>(
      "X_MONTHLY_BUDGET_CENTS",
    );
    const parsed =
      typeof rawBudget === "number" ? rawBudget : Number(rawBudget);
    const monthlyBudgetCents =
      Number.isFinite(parsed) && parsed >= 0 ? Math.floor(parsed) : 300;
    return { clientId, clientSecret, encryptionKey, monthlyBudgetCents };
  }

  /** bible.helloao.org translation ID. Defaults to BSB (public domain, modern English). */
  scriptureTranslation(): string {
    const v = this.config.get<string>("SCRIPTURE_TRANSLATION")?.trim() ?? "";
    return v || "BSB";
  }

  rateLimitTtlSeconds(): number {
    const raw = this.config.get<string>("RATE_LIMIT_TTL_SECONDS") ?? "";
    const n = Number(raw);
    return Number.isFinite(n) && n > 0 ? n : 60;
  }

  rateLimitLimit(): number {
    const raw = this.config.get<string>("RATE_LIMIT_LIMIT") ?? "";
    const n = Number(raw);
    // Pretty generous default.
    return Number.isFinite(n) && n > 0 ? n : 600;
  }

  protected readPositiveInt(key: string, fallback: number) {
    const raw = this.config.get<string>(key) ?? "";
    const n = Number(raw);
    return Number.isFinite(n) && n > 0 ? Math.floor(n) : fallback;
  }

  rateLimitAuthStartTtlSeconds(): number {
    return this.readPositiveInt("RATE_LIMIT_AUTH_START_TTL_SECONDS", 60);
  }
  rateLimitAuthStartLimit(): number {
    return this.readPositiveInt("RATE_LIMIT_AUTH_START_LIMIT", 8);
  }

  rateLimitAuthVerifyTtlSeconds(): number {
    return this.readPositiveInt("RATE_LIMIT_AUTH_VERIFY_TTL_SECONDS", 60);
  }
  rateLimitAuthVerifyLimit(): number {
    return this.readPositiveInt("RATE_LIMIT_AUTH_VERIFY_LIMIT", 20);
  }

  rateLimitPostCreateTtlSeconds(): number {
    return this.readPositiveInt("RATE_LIMIT_POST_CREATE_TTL_SECONDS", 60);
  }
  rateLimitPostCreateLimit(): number {
    return this.readPositiveInt("RATE_LIMIT_POST_CREATE_LIMIT", 30);
  }

  rateLimitInteractTtlSeconds(): number {
    return this.readPositiveInt("RATE_LIMIT_INTERACT_TTL_SECONDS", 60);
  }
  rateLimitInteractLimit(): number {
    return this.readPositiveInt("RATE_LIMIT_INTERACT_LIMIT", 180);
  }

  rateLimitUploadTtlSeconds(): number {
    return this.readPositiveInt("RATE_LIMIT_UPLOAD_TTL_SECONDS", 60);
  }
  rateLimitUploadLimit(): number {
    return this.readPositiveInt("RATE_LIMIT_UPLOAD_LIMIT", 60);
  }

  trustProxy(): boolean {
    const raw = this.config.get<string>("TRUST_PROXY") ?? "";
    const v = raw.trim().toLowerCase();
    return ["1", "true", "yes", "on"].includes(v);
  }

  bodyJsonLimit(): string {
    return (
      (this.config.get<string>("BODY_JSON_LIMIT") ?? "1mb").trim() || "1mb"
    );
  }

  bodyUrlEncodedLimit(): string {
    return (
      (this.config.get<string>("BODY_URLENCODED_LIMIT") ?? "25kb").trim() ||
      "25kb"
    );
  }

  requireCsrfOriginInProd(): boolean {
    const raw = this.config.get<string>("REQUIRE_CSRF_ORIGIN_IN_PROD") ?? "";
    const v = raw.trim().toLowerCase();
    // default true
    if (!v) return true;
    return ["1", "true", "yes", "on"].includes(v);
  }

  logRequests(): boolean {
    // Only meaningful in non-prod; still allow explicit opt-in elsewhere if needed.
    const raw = this.config.get<string>("LOG_REQUESTS") ?? "";
    const v = raw.trim().toLowerCase();
    return ["1", "true", "yes", "on"].includes(v);
  }

  logStartupInfo(): boolean {
    const raw = this.config.get<string>("LOG_STARTUP_INFO") ?? "";
    const v = raw.trim().toLowerCase();
    return ["1", "true", "yes", "on"].includes(v);
  }

  /** Minutes with no activity ping before marking user idle (show clock). */
  presenceIdleAfterMinutes(): number {
    return this.readPositiveInt("PRESENCE_IDLE_AFTER_MINUTES", 3);
  }

  /** If user stays idle this many minutes, disconnect them (socket closed, considered offline). */
  presenceIdleDisconnectMinutes(): number {
    return this.readPositiveInt("PRESENCE_IDLE_DISCONNECT_MINUTES", 15);
  }

  /** Web Push VAPID public key (for browser push subscriptions). Generate: npx web-push generate-vapid-keys */
  vapidPublicKey(): string | null {
    const v = this.config.get<string>("VAPID_PUBLIC_KEY")?.trim() ?? "";
    return v ? v : null;
  }

  /** Web Push VAPID private key. Required to send push; if unset, subscriptions are stored but no push is sent. */
  vapidPrivateKey(): string | null {
    const v = this.config.get<string>("VAPID_PRIVATE_KEY")?.trim() ?? "";
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
  apns(): {
    keyId: string;
    teamId: string;
    privateKey: string;
    bundleId: string;
  } | null {
    const keyId = this.config.get<string>("APNS_KEY_ID")?.trim() ?? "";
    const teamId = this.config.get<string>("APNS_TEAM_ID")?.trim() ?? "";
    const rawKey = this.config.get<string>("APNS_PRIVATE_KEY") ?? "";
    const privateKey = rawKey.replace(/\\n/g, "\n").trim();
    const bundleId = this.config.get<string>("APNS_BUNDLE_ID")?.trim() ?? "";
    if (!keyId || !teamId || !privateKey || !bundleId) return null;
    return { keyId, teamId, privateKey, bundleId };
  }

  /** True if all APNS_* env vars are set (native iOS push can be sent). */
  apnsConfigured(): boolean {
    return this.apns() !== null;
  }

  /** Base URL for push notification click-through (canonical frontend). If unset, first ALLOWED_ORIGINS entry is used. */
  pushFrontendBaseUrl(): string | null {
    const v = this.config.get<string>("PUSH_FRONTEND_BASE_URL")?.trim() ?? "";
    return v ? v : null;
  }

  /** Canonical frontend base URL. Prefer explicit PUSH_FRONTEND_BASE_URL, else first allowed origin. */
  frontendBaseUrl(): string | null {
    const explicit = this.pushFrontendBaseUrl();
    if (explicit) return explicit;
    const first = this.allowedOrigins()[0];
    return first ? first : null;
  }

  /**
   * Returns the Apple IAP configuration when all required env vars are set.
   * Returns null when any required value is missing (IAP endpoints will reject gracefully).
   */
  appleIap(): AppleIapConfig | null {
    const bundleId =
      this.config.get<string>("APPLE_IAP_BUNDLE_ID")?.trim() ?? "";
    const issuerId =
      this.config.get<string>("APPLE_IAP_ISSUER_ID")?.trim() ?? "";
    const keyId = this.config.get<string>("APPLE_IAP_KEY_ID")?.trim() ?? "";
    const rawKey = this.config.get<string>("APPLE_IAP_PRIVATE_KEY") ?? "";
    const privateKey = rawKey.replace(/\\n/g, "\n").trim();
    const productTierMapRaw =
      this.config.get<string>("APPLE_IAP_PRODUCT_TIER_MAP")?.trim() ?? "";

    if (!bundleId || !issuerId || !keyId || !privateKey) return null;

    let productTierMap: Record<string, "premium" | "premiumPlus"> = {};
    if (productTierMapRaw) {
      try {
        productTierMap = JSON.parse(productTierMapRaw);
      } catch {
        this.logger.warn(
          "APPLE_IAP_PRODUCT_TIER_MAP is not valid JSON; defaulting to empty map.",
        );
      }
    }

    const environment =
      this.config.get<string>("APPLE_IAP_ENVIRONMENT")?.trim() === "production"
        ? "production"
        : "sandbox";
    const appAppleIdRaw =
      this.config.get<string>("APPLE_IAP_APP_APPLE_ID")?.trim() ?? "";
    const appAppleId =
      appAppleIdRaw && /^\d+$/.test(appAppleIdRaw)
        ? Number(appAppleIdRaw)
        : null;

    if (environment === "production" && appAppleId === null) {
      this.logger.warn(
        "APPLE_IAP_ENVIRONMENT=production but APPLE_IAP_APP_APPLE_ID is missing; Apple signed-data verification will fail.",
      );
    }

    return {
      bundleId,
      issuerId,
      keyId,
      privateKey,
      productTierMap,
      environment,
      appAppleId,
    };
  }

  stripe(): StripeConfig | null {
    const secretKey =
      this.config.get<string>("STRIPE_SECRET_KEY")?.trim() ?? "";
    const webhookSecret =
      this.config.get<string>("STRIPE_WEBHOOK_SECRET")?.trim() ?? "";
    const pricePremiumMonthly =
      this.config.get<string>("STRIPE_PRICE_PREMIUM_MONTHLY")?.trim() ?? "";
    const pricePremiumPlusMonthly =
      this.config.get<string>("STRIPE_PRICE_PREMIUM_PLUS_MONTHLY")?.trim() ??
      "";
    const frontendBaseUrl = this.frontendBaseUrl()?.trim() ?? "";

    if (
      !secretKey ||
      !webhookSecret ||
      !pricePremiumMonthly ||
      !pricePremiumPlusMonthly ||
      !frontendBaseUrl
    )
      return null;
    return {
      secretKey,
      webhookSecret,
      pricePremiumMonthly,
      pricePremiumPlusMonthly,
      frontendBaseUrl,
    };
  }

  email(): EmailConfig | null {
    const resendApiKey =
      this.config.get<string>("RESEND_API_KEY")?.trim() ?? "";
    const resendFromDefault =
      this.config.get<string>("RESEND_FROM_EMAIL")?.trim() ?? "";
    const resendFromNotifications =
      this.config.get<string>("RESEND_FROM_NOTIFICATIONS_EMAIL")?.trim() ?? "";
    const resendFromSupport =
      this.config.get<string>("RESEND_FROM_SUPPORT_EMAIL")?.trim() ?? "";
    const resendFromNewsletter =
      this.config.get<string>("RESEND_FROM_NEWSLETTER_EMAIL")?.trim() ?? "";

    const fallback = resendFromDefault;
    const notifications = resendFromNotifications || fallback;
    const support = resendFromSupport || fallback;
    const newsletter = resendFromNewsletter || notifications || fallback;
    const effectiveDefault = fallback || notifications || support || newsletter;

    if (resendApiKey && effectiveDefault) {
      return {
        provider: "resend",
        apiKey: resendApiKey,
        fromEmail: {
          default: withDisplayName(effectiveDefault, "Men of Hunger"),
          notifications: withDisplayName(
            notifications || effectiveDefault,
            "Men of Hunger",
          ),
          support: withDisplayName(
            support || effectiveDefault,
            "Men of Hunger",
          ),
          newsletter: withDisplayName(
            newsletter || effectiveDefault,
            "Men of Hunger",
          ),
        },
      };
    }
    return null;
  }

  /**
   * Maximum transactional emails allowed per UTC day across all send paths.
   * Matches the Resend free-tier hard limit (100). Raise when upgrading plans.
   */
  emailDailyQuotaLimit(): number {
    const raw = this.config.get<string>("EMAIL_DAILY_QUOTA_LIMIT") ?? "";
    const n = Number(raw.trim());
    return Number.isFinite(n) && n > 0 ? Math.floor(n) : 100;
  }

  /**
   * Number of sends reserved for transactional email (verification) per day.
   * Engagement sends are blocked once (quotaLimit - reserve) is reached.
   */
  emailDailyVerificationReserve(): number {
    const raw =
      this.config.get<string>("EMAIL_DAILY_VERIFICATION_RESERVE") ?? "";
    const n = Number(raw.trim());
    return Number.isFinite(n) && n >= 0 ? Math.floor(n) : 15;
  }

  /**
   * When false, per-publish article fan-out emails are skipped.
   * New articles still appear in the weekly digest.
   * Disable on the Resend free tier; enable after upgrading.
   */
  emailFollowedArticleEnabled(): boolean {
    return this.readBool("EMAIL_FOLLOWED_ARTICLE_ENABLED", false);
  }

  /** Daily cap for admin newsletter blasts. Independent of engagement/transactional quota. */
  emailBroadcastDailyQuota(): number {
    const raw = this.config.get<string>("EMAIL_BROADCAST_DAILY_QUOTA") ?? "";
    const n = Number(raw.trim());
    return Number.isFinite(n) && n > 0 ? Math.floor(n) : 5000;
  }

  /** Physical mailing address required in newsletter footers (CAN-SPAM). */
  newsletterPostalAddress(): string | null {
    const v =
      this.config.get<string>("NEWSLETTER_POSTAL_ADDRESS")?.trim() ?? "";
    return v ? v : null;
  }

  slackWebhookUrl(): string | null {
    const v = this.config.get<string>("SLACK_WEBHOOK_URL")?.trim() ?? "";
    return v ? v : null;
  }

  posthogApiKey(): string | null {
    const v = this.config.get<string>("POSTHOG_API_KEY")?.trim() ?? "";
    return v ? v : null;
  }

  posthogHost(): string {
    return (
      this.config.get<string>("POSTHOG_HOST")?.trim() ||
      "https://us.i.posthog.com"
    ).trim();
  }

  /** PostHog "Feature flags secure API key" (phs_…); enables local flag evaluation. */
  posthogFeatureFlagsKey(): string | null {
    const v =
      this.config.get<string>("POSTHOG_FEATURE_FLAGS_KEY")?.trim() ?? "";
    return v ? v : null;
  }

  // ─── Marv (AI helper) ────────────────────────────────────────────────────
}
