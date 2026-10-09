import { z } from "zod";

/** Core runtime, auth, storage, throttling, push, billing, and email environment variables. */
export const coreEnvShape = {
    NODE_ENV: z
      .enum(["development", "test", "production"])
      .default("development"),
    PORT: z
      .string()
      .optional()
      .refine(
        (v) => (v ? !Number.isNaN(Number(v)) : true),
        "PORT must be a number",
      ),
    MOH_LOCAL_BILLING_TESTS: z.enum(["0", "1"]).optional(),
    DATABASE_URL: z.string().min(1, "DATABASE_URL is required"),

    // Redis (BullMQ). Default is dev-friendly; require explicit value in production.
    REDIS_URL: z.preprocess(
      (v) => (typeof v === "string" && v.trim() === "" ? undefined : v),
      z.string().optional().default("redis://localhost:6379"),
    ),

    // Process roles (enable/disable parts of the app for API vs worker deployments).
    RUN_HTTP: z.preprocess(
      (v) => (typeof v === "string" && v.trim() === "" ? undefined : v),
      z.string().optional().default("true"),
    ),
    RUN_SCHEDULERS: z.preprocess(
      (v) => (typeof v === "string" && v.trim() === "" ? undefined : v),
      z.string().optional().default("true"),
    ),
    RUN_JOB_CONSUMERS: z.preprocess(
      (v) => (typeof v === "string" && v.trim() === "" ? undefined : v),
      z.string().optional().default("true"),
    ),

    // In-flight side-effect jobs per worker (notifications, push, fan-out).
    SIDE_EFFECTS_QUEUE_CONCURRENCY: z
      .string()
      .optional()
      .refine(
        (v) => (v ? !Number.isNaN(Number(v)) : true),
        "SIDE_EFFECTS_QUEUE_CONCURRENCY must be a number",
      ),

    // Prisma connection retry (e.g. when Postgres is starting in docker compose).
    PRISMA_CONNECT_RETRIES: z
      .string()
      .optional()
      .refine(
        (v) => (v ? !Number.isNaN(Number(v)) : true),
        "PRISMA_CONNECT_RETRIES must be a number",
      ),
    PRISMA_CONNECT_RETRY_DELAY_MS: z
      .string()
      .optional()
      .refine(
        (v) => (v ? !Number.isNaN(Number(v)) : true),
        "PRISMA_CONNECT_RETRY_DELAY_MS must be a number",
      ),

    // Comma-separated list of allowed web origins for CORS (must be explicit when using cookies).
    // Examples:
    // - http://localhost:3000
    // - https://menofhunger.com
    // Note: some hosts inject empty strings for unset env vars. Treat "" as unset.
    ALLOWED_ORIGINS: z.preprocess(
      (v) => (typeof v === "string" && v.trim() === "" ? undefined : v),
      z.string().optional().default("http://localhost:3000"),
    ),

    // Secrets (recommended in all envs; required in production)
    // Note: treat empty strings as unset; provide dev defaults so app code never reads process.env directly.
    OTP_HMAC_SECRET: z.preprocess(
      (v) => (typeof v === "string" && v.trim() === "" ? undefined : v),
      z.string().optional().default("dev-otp-secret-change-me"),
    ),
    SESSION_HMAC_SECRET: z.preprocess(
      (v) => (typeof v === "string" && v.trim() === "" ? undefined : v),
      z.string().optional().default("dev-session-secret-change-me"),
    ),

    // Cookie domain. In production you likely want `.menofhunger.com`.
    COOKIE_DOMAIN: z.preprocess(
      (v) => (typeof v === "string" && v.trim() === "" ? undefined : v),
      z.string().optional(),
    ),

    // Canonical public API base, including the version prefix, used for one-time
    // native-to-browser handoff URLs (for example https://api.menofhunger.com/v1).
    BROWSER_HANDOFF_BASE_URL: z.preprocess(
      (v) => (typeof v === "string" && v.trim() === "" ? undefined : v),
      z.string().url().optional(),
    ),

    // Dev-only: if true, do not attempt to send SMS via Twilio (use 000000 bypass flow).
    DISABLE_TWILIO_IN_DEV: z.preprocess(
      (v) => (typeof v === "string" && v.trim() === "" ? undefined : v),
      z.string().optional(),
    ),

    // App Review: a single phone number that App Review can sign in with using a fixed code,
    // bypassing Twilio even in production. Only active when both vars are set.
    // Set these in your production env and supply them in App Store Connect Review Notes.
    APP_REVIEW_PHONE: z.preprocess(
      (v) => (typeof v === "string" && v.trim() === "" ? undefined : v),
      z.string().optional(),
    ),
    APP_REVIEW_CODE: z.preprocess(
      (v) => (typeof v === "string" && v.trim() === "" ? undefined : v),
      z.string().optional(),
    ),

    // Twilio (production only)
    TWILIO_ACCOUNT_SID: z.preprocess(
      (v) => (typeof v === "string" && v.trim() === "" ? undefined : v),
      z.string().optional(),
    ),
    TWILIO_AUTH_TOKEN: z.preprocess(
      (v) => (typeof v === "string" && v.trim() === "" ? undefined : v),
      z.string().optional(),
    ),
    // Twilio Verify Service SID (starts with VA...)
    TWILIO_VERIFY_SERVICE_SID: z.preprocess(
      (v) => (typeof v === "string" && v.trim() === "" ? undefined : v),
      z.string().optional(),
    ),
    // Legacy (not used when TWILIO_VERIFY_SERVICE_SID is set)
    TWILIO_FROM_NUMBER: z.preprocess(
      (v) => (typeof v === "string" && v.trim() === "" ? undefined : v),
      z.string().optional(),
    ),
    TWILIO_MESSAGING_SERVICE_SID: z.preprocess(
      (v) => (typeof v === "string" && v.trim() === "" ? undefined : v),
      z.string().optional(),
    ),

    // SFU rollout is opt-in; credentials alone must never change live call routing.
    CLOUDFLARE_SFU_APP_ID: z.string().optional(),
    CLOUDFLARE_SFU_APP_SECRET: z.string().optional(),
    CALLS_BUDGET_BYTES_PER_SECOND: z.coerce
      .number()
      .int()
      .positive()
      .default(1_000_000),
    CALLS_SFU_ENABLED: z.enum(["true", "false"]).optional().default("false"),

    // Cloudflare R2 (S3-compatible) for public assets (avatars/banners).
    R2_ACCOUNT_ID: z.preprocess(
      (v) => (typeof v === "string" && v.trim() === "" ? undefined : v),
      z.string().optional(),
    ),
    R2_ACCESS_KEY_ID: z.preprocess(
      (v) => (typeof v === "string" && v.trim() === "" ? undefined : v),
      z.string().optional(),
    ),
    R2_SECRET_ACCESS_KEY: z.preprocess(
      (v) => (typeof v === "string" && v.trim() === "" ? undefined : v),
      z.string().optional(),
    ),
    R2_BUCKET: z.preprocess(
      (v) => (typeof v === "string" && v.trim() === "" ? undefined : v),
      z.string().optional(),
    ),
    // Public base URL for reading objects, e.g. https://moh-assets.<accountId>.r2.dev
    R2_PUBLIC_BASE_URL: z.preprocess(
      (v) => (typeof v === "string" && v.trim() === "" ? undefined : v),
      z.string().optional(),
    ),

    // Giphy (server-side proxy for GIF search)
    GIPHY_API_KEY: z.preprocess(
      (v) => (typeof v === "string" && v.trim() === "" ? undefined : v),
      z.string().optional(),
    ),

    // Scripture translation ID for bible.helloao.org (default: BSB = Berean Standard Bible).
    // Set to a different ID (e.g. NKJV) once a commercial licence is in place.
    SCRIPTURE_TRANSLATION: z.preprocess(
      (v) => (typeof v === "string" && v.trim() === "" ? undefined : v),
      z.string().optional(),
    ),

    // Global API rate limiting (generous defaults if unset).
    RATE_LIMIT_TTL_SECONDS: z
      .string()
      .optional()
      .refine(
        (v) => (v ? !Number.isNaN(Number(v)) : true),
        "RATE_LIMIT_TTL_SECONDS must be a number",
      ),
    RATE_LIMIT_LIMIT: z
      .string()
      .optional()
      .refine(
        (v) => (v ? !Number.isNaN(Number(v)) : true),
        "RATE_LIMIT_LIMIT must be a number",
      ),

    // Route-specific throttles (all optional; defaults are reasonable).
    RATE_LIMIT_AUTH_START_TTL_SECONDS: z
      .string()
      .optional()
      .refine(
        (v) => (v ? !Number.isNaN(Number(v)) : true),
        "RATE_LIMIT_AUTH_START_TTL_SECONDS must be a number",
      ),
    RATE_LIMIT_AUTH_START_LIMIT: z
      .string()
      .optional()
      .refine(
        (v) => (v ? !Number.isNaN(Number(v)) : true),
        "RATE_LIMIT_AUTH_START_LIMIT must be a number",
      ),

    RATE_LIMIT_AUTH_VERIFY_TTL_SECONDS: z
      .string()
      .optional()
      .refine(
        (v) => (v ? !Number.isNaN(Number(v)) : true),
        "RATE_LIMIT_AUTH_VERIFY_TTL_SECONDS must be a number",
      ),
    RATE_LIMIT_AUTH_VERIFY_LIMIT: z
      .string()
      .optional()
      .refine(
        (v) => (v ? !Number.isNaN(Number(v)) : true),
        "RATE_LIMIT_AUTH_VERIFY_LIMIT must be a number",
      ),

    RATE_LIMIT_POST_CREATE_TTL_SECONDS: z
      .string()
      .optional()
      .refine(
        (v) => (v ? !Number.isNaN(Number(v)) : true),
        "RATE_LIMIT_POST_CREATE_TTL_SECONDS must be a number",
      ),
    RATE_LIMIT_POST_CREATE_LIMIT: z
      .string()
      .optional()
      .refine(
        (v) => (v ? !Number.isNaN(Number(v)) : true),
        "RATE_LIMIT_POST_CREATE_LIMIT must be a number",
      ),

    RATE_LIMIT_INTERACT_TTL_SECONDS: z
      .string()
      .optional()
      .refine(
        (v) => (v ? !Number.isNaN(Number(v)) : true),
        "RATE_LIMIT_INTERACT_TTL_SECONDS must be a number",
      ),
    RATE_LIMIT_INTERACT_LIMIT: z
      .string()
      .optional()
      .refine(
        (v) => (v ? !Number.isNaN(Number(v)) : true),
        "RATE_LIMIT_INTERACT_LIMIT must be a number",
      ),

    RATE_LIMIT_UPLOAD_TTL_SECONDS: z
      .string()
      .optional()
      .refine(
        (v) => (v ? !Number.isNaN(Number(v)) : true),
        "RATE_LIMIT_UPLOAD_TTL_SECONDS must be a number",
      ),
    RATE_LIMIT_UPLOAD_LIMIT: z
      .string()
      .optional()
      .refine(
        (v) => (v ? !Number.isNaN(Number(v)) : true),
        "RATE_LIMIT_UPLOAD_LIMIT must be a number",
      ),

    // Express / proxy settings (recommended in production behind a reverse proxy / Cloudflare).
    // When enabled, Express will respect X-Forwarded-* headers for req.ip / req.protocol.
    TRUST_PROXY: z.preprocess(
      (v) => (typeof v === "string" && v.trim() === "" ? undefined : v),
      z.string().optional(),
    ),

    // Body size limits (protects memory + prevents accidental huge payloads).
    BODY_JSON_LIMIT: z.preprocess(
      (v) => (typeof v === "string" && v.trim() === "" ? undefined : v),
      z.string().optional().default("1mb"),
    ),
    BODY_URLENCODED_LIMIT: z.preprocess(
      (v) => (typeof v === "string" && v.trim() === "" ? undefined : v),
      z.string().optional().default("25kb"),
    ),

    // CSRF hardening (cookie auth): require Origin/Referer on unsafe methods in production.
    REQUIRE_CSRF_ORIGIN_IN_PROD: z.preprocess(
      (v) => (typeof v === "string" && v.trim() === "" ? undefined : v),
      z.string().optional().default("true"),
    ),

    // Dev-only: log every request (method, path, status, ms, request-id).
    LOG_REQUESTS: z.preprocess(
      (v) => (typeof v === "string" && v.trim() === "" ? undefined : v),
      z.string().optional(),
    ),

    // Dev-only: print startup config summary (opt-in).
    LOG_STARTUP_INFO: z.preprocess(
      (v) => (typeof v === "string" && v.trim() === "" ? undefined : v),
      z.string().optional(),
    ),

    // Presence: minutes with no activity ping before marking user idle (default 3).
    PRESENCE_IDLE_AFTER_MINUTES: z
      .string()
      .optional()
      .refine(
        (v) => (v ? !Number.isNaN(Number(v)) : true),
        "PRESENCE_IDLE_AFTER_MINUTES must be a number",
      ),
    // Presence: if user stays idle this many minutes, disconnect them (consider offline and close socket).
    PRESENCE_IDLE_DISCONNECT_MINUTES: z
      .string()
      .optional()
      .refine(
        (v) => (v ? !Number.isNaN(Number(v)) : true),
        "PRESENCE_IDLE_DISCONNECT_MINUTES must be a number",
      ),

    // Web Push (browser notifications). Generate: npx web-push generate-vapid-keys
    VAPID_PUBLIC_KEY: z.preprocess(
      (v) => (typeof v === "string" && v.trim() === "" ? undefined : v),
      z.string().optional(),
    ),
    VAPID_PRIVATE_KEY: z.preprocess(
      (v) => (typeof v === "string" && v.trim() === "" ? undefined : v),
      z.string().optional(),
    ),
    // Base URL for push notification click-through (canonical frontend). If unset, first ALLOWED_ORIGINS entry is used.
    PUSH_FRONTEND_BASE_URL: z.preprocess(
      (v) => (typeof v === "string" && v.trim() === "" ? undefined : v),
      z.string().optional(),
    ),

    // Apple IAP (StoreKit 2 / App Store Server API)
    APPLE_IAP_BUNDLE_ID: z.preprocess(
      (v) => (typeof v === "string" && v.trim() === "" ? undefined : v),
      z.string().optional(),
    ),
    // Issuer ID from App Store Connect → Users and Access → Integrations → In-App Purchase
    APPLE_IAP_ISSUER_ID: z.preprocess(
      (v) => (typeof v === "string" && v.trim() === "" ? undefined : v),
      z.string().optional(),
    ),
    // Key ID from App Store Connect (the short ID shown under your subscription key)
    APPLE_IAP_KEY_ID: z.preprocess(
      (v) => (typeof v === "string" && v.trim() === "" ? undefined : v),
      z.string().optional(),
    ),
    // Contents of the .p8 key file. Literal "\n" sequences are normalized to newlines at read time.
    APPLE_IAP_PRIVATE_KEY: z.preprocess(
      (v) => (typeof v === "string" && v.trim() === "" ? undefined : v),
      z.string().optional(),
    ),
    // JSON map of productId -> tier, e.g. '{"com.menofhunger.premium":"premium","com.menofhunger.premiumplus":"premiumPlus"}'
    APPLE_IAP_PRODUCT_TIER_MAP: z.preprocess(
      (v) => (typeof v === "string" && v.trim() === "" ? undefined : v),
      z.string().optional(),
    ),
    // App Store environment to verify signed data against: 'sandbox' (default) or 'production'.
    APPLE_IAP_ENVIRONMENT: z.preprocess(
      (v) => (typeof v === "string" && v.trim() === "" ? undefined : v),
      z.enum(["sandbox", "production"]).optional(),
    ),
    // Numeric App Store app ID (App Store Connect → App Information → "Apple ID"). Required in production.
    APPLE_IAP_APP_APPLE_ID: z.preprocess(
      (v) => (typeof v === "string" && v.trim() === "" ? undefined : v),
      z.string().optional(),
    ),

    // Stripe billing (Premium / Premium+ subscriptions)
    STRIPE_SECRET_KEY: z.preprocess(
      (v) => (typeof v === "string" && v.trim() === "" ? undefined : v),
      z.string().optional(),
    ),
    STRIPE_WEBHOOK_SECRET: z.preprocess(
      (v) => (typeof v === "string" && v.trim() === "" ? undefined : v),
      z.string().optional(),
    ),
    STRIPE_PRICE_PREMIUM_MONTHLY: z.preprocess(
      (v) => (typeof v === "string" && v.trim() === "" ? undefined : v),
      z.string().optional(),
    ),
    STRIPE_PRICE_PREMIUM_PLUS_MONTHLY: z.preprocess(
      (v) => (typeof v === "string" && v.trim() === "" ? undefined : v),
      z.string().optional(),
    ),

    // Email (optional): configure Mailgun for digests/re-engagement.
    // Email (optional): Resend (digests + verification + nudges).
    RESEND_API_KEY: z.preprocess(
      (v) => (typeof v === "string" && v.trim() === "" ? undefined : v),
      z.string().optional(),
    ),
    RESEND_FROM_EMAIL: z.preprocess(
      (v) => (typeof v === "string" && v.trim() === "" ? undefined : v),
      z.string().optional(),
    ),
    RESEND_FROM_NOTIFICATIONS_EMAIL: z.preprocess(
      (v) => (typeof v === "string" && v.trim() === "" ? undefined : v),
      z.string().optional(),
    ),
    RESEND_FROM_SUPPORT_EMAIL: z.preprocess(
      (v) => (typeof v === "string" && v.trim() === "" ? undefined : v),
      z.string().optional(),
    ),
    RESEND_FROM_NEWSLETTER_EMAIL: z.preprocess(
      (v) => (typeof v === "string" && v.trim() === "" ? undefined : v),
      z.string().optional(),
    ),

    // Slack Incoming Webhook URL (optional; notifications silently no-op when unset).
    // Create one at: https://api.slack.com/apps → your app → Incoming Webhooks
    SLACK_WEBHOOK_URL: z.preprocess(
      (v) => (typeof v === "string" && v.trim() === "" ? undefined : v),
      z.string().optional(),
    ),

};
