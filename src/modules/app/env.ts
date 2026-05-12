import { z } from 'zod';
import {
  MARV_DEFAULT_FAST_MODEL,
  MARV_DEFAULT_REGULAR_MODEL,
  MARV_DEFAULT_SMART_MODEL,
} from '../marvin/marvin-models';

export const envSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  PORT: z
    .string()
    .optional()
    .refine((v) => (v ? !Number.isNaN(Number(v)) : true), 'PORT must be a number'),
  DATABASE_URL: z.string().min(1, 'DATABASE_URL is required'),

  // Redis (BullMQ). Default is dev-friendly; require explicit value in production.
  REDIS_URL: z.preprocess(
    (v) => (typeof v === 'string' && v.trim() === '' ? undefined : v),
    z.string().optional().default('redis://localhost:6379'),
  ),

  // Process roles (enable/disable parts of the app for API vs worker deployments).
  RUN_HTTP: z.preprocess(
    (v) => (typeof v === 'string' && v.trim() === '' ? undefined : v),
    z.string().optional().default('true'),
  ),
  RUN_SCHEDULERS: z.preprocess(
    (v) => (typeof v === 'string' && v.trim() === '' ? undefined : v),
    z.string().optional().default('true'),
  ),
  RUN_JOB_CONSUMERS: z.preprocess(
    (v) => (typeof v === 'string' && v.trim() === '' ? undefined : v),
    z.string().optional().default('true'),
  ),

  // Prisma connection retry (e.g. when Postgres is starting in docker compose).
  PRISMA_CONNECT_RETRIES: z
    .string()
    .optional()
    .refine((v) => (v ? !Number.isNaN(Number(v)) : true), 'PRISMA_CONNECT_RETRIES must be a number'),
  PRISMA_CONNECT_RETRY_DELAY_MS: z
    .string()
    .optional()
    .refine((v) => (v ? !Number.isNaN(Number(v)) : true), 'PRISMA_CONNECT_RETRY_DELAY_MS must be a number'),

  // Comma-separated list of allowed web origins for CORS (must be explicit when using cookies).
  // Examples:
  // - http://localhost:3000
  // - https://menofhunger.com
  // Note: some hosts inject empty strings for unset env vars. Treat "" as unset.
  ALLOWED_ORIGINS: z.preprocess(
    (v) => (typeof v === 'string' && v.trim() === '' ? undefined : v),
    z.string().optional().default('http://localhost:3000'),
  ),

  // Secrets (recommended in all envs; required in production)
  // Note: treat empty strings as unset; provide dev defaults so app code never reads process.env directly.
  OTP_HMAC_SECRET: z.preprocess(
    (v) => (typeof v === 'string' && v.trim() === '' ? undefined : v),
    z.string().optional().default('dev-otp-secret-change-me'),
  ),
  SESSION_HMAC_SECRET: z.preprocess(
    (v) => (typeof v === 'string' && v.trim() === '' ? undefined : v),
    z.string().optional().default('dev-session-secret-change-me'),
  ),

  // Cookie domain. In production you likely want `.menofhunger.com`.
  COOKIE_DOMAIN: z.preprocess(
    (v) => (typeof v === 'string' && v.trim() === '' ? undefined : v),
    z.string().optional(),
  ),

  // Dev-only: if true, do not attempt to send SMS via Twilio (use 000000 bypass flow).
  DISABLE_TWILIO_IN_DEV: z.preprocess(
    (v) => (typeof v === 'string' && v.trim() === '' ? undefined : v),
    z.string().optional(),
  ),

  // Twilio (production only)
  TWILIO_ACCOUNT_SID: z.preprocess(
    (v) => (typeof v === 'string' && v.trim() === '' ? undefined : v),
    z.string().optional(),
  ),
  TWILIO_AUTH_TOKEN: z.preprocess(
    (v) => (typeof v === 'string' && v.trim() === '' ? undefined : v),
    z.string().optional(),
  ),
  // Twilio Verify Service SID (starts with VA...)
  TWILIO_VERIFY_SERVICE_SID: z.preprocess(
    (v) => (typeof v === 'string' && v.trim() === '' ? undefined : v),
    z.string().optional(),
  ),
  // Legacy (not used when TWILIO_VERIFY_SERVICE_SID is set)
  TWILIO_FROM_NUMBER: z.preprocess(
    (v) => (typeof v === 'string' && v.trim() === '' ? undefined : v),
    z.string().optional(),
  ),
  TWILIO_MESSAGING_SERVICE_SID: z.preprocess(
    (v) => (typeof v === 'string' && v.trim() === '' ? undefined : v),
    z.string().optional(),
  ),

  // Cloudflare R2 (S3-compatible) for public assets (avatars/banners).
  R2_ACCOUNT_ID: z.preprocess(
    (v) => (typeof v === 'string' && v.trim() === '' ? undefined : v),
    z.string().optional(),
  ),
  R2_ACCESS_KEY_ID: z.preprocess(
    (v) => (typeof v === 'string' && v.trim() === '' ? undefined : v),
    z.string().optional(),
  ),
  R2_SECRET_ACCESS_KEY: z.preprocess(
    (v) => (typeof v === 'string' && v.trim() === '' ? undefined : v),
    z.string().optional(),
  ),
  R2_BUCKET: z.preprocess(
    (v) => (typeof v === 'string' && v.trim() === '' ? undefined : v),
    z.string().optional(),
  ),
  // Public base URL for reading objects, e.g. https://moh-assets.<accountId>.r2.dev
  R2_PUBLIC_BASE_URL: z.preprocess(
    (v) => (typeof v === 'string' && v.trim() === '' ? undefined : v),
    z.string().optional(),
  ),

  // Giphy (server-side proxy for GIF search)
  GIPHY_API_KEY: z.preprocess(
    (v) => (typeof v === 'string' && v.trim() === '' ? undefined : v),
    z.string().optional(),
  ),

  // Mapbox (location normalization / geocoding). Optional; required only if location is enabled.
  MAPBOX_ACCESS_TOKEN: z.preprocess(
    (v) => (typeof v === 'string' && v.trim() === '' ? undefined : v),
    z.string().optional(),
  ),
  MAPBOX_GEOCODE_TIMEOUT_MS: z
    .string()
    .optional()
    .refine((v) => (v ? !Number.isNaN(Number(v)) : true), 'MAPBOX_GEOCODE_TIMEOUT_MS must be a number'),

  // Global API rate limiting (generous defaults if unset).
  RATE_LIMIT_TTL_SECONDS: z
    .string()
    .optional()
    .refine((v) => (v ? !Number.isNaN(Number(v)) : true), 'RATE_LIMIT_TTL_SECONDS must be a number'),
  RATE_LIMIT_LIMIT: z
    .string()
    .optional()
    .refine((v) => (v ? !Number.isNaN(Number(v)) : true), 'RATE_LIMIT_LIMIT must be a number'),

  // Route-specific throttles (all optional; defaults are reasonable).
  RATE_LIMIT_AUTH_START_TTL_SECONDS: z
    .string()
    .optional()
    .refine((v) => (v ? !Number.isNaN(Number(v)) : true), 'RATE_LIMIT_AUTH_START_TTL_SECONDS must be a number'),
  RATE_LIMIT_AUTH_START_LIMIT: z
    .string()
    .optional()
    .refine((v) => (v ? !Number.isNaN(Number(v)) : true), 'RATE_LIMIT_AUTH_START_LIMIT must be a number'),

  RATE_LIMIT_AUTH_VERIFY_TTL_SECONDS: z
    .string()
    .optional()
    .refine((v) => (v ? !Number.isNaN(Number(v)) : true), 'RATE_LIMIT_AUTH_VERIFY_TTL_SECONDS must be a number'),
  RATE_LIMIT_AUTH_VERIFY_LIMIT: z
    .string()
    .optional()
    .refine((v) => (v ? !Number.isNaN(Number(v)) : true), 'RATE_LIMIT_AUTH_VERIFY_LIMIT must be a number'),

  RATE_LIMIT_POST_CREATE_TTL_SECONDS: z
    .string()
    .optional()
    .refine((v) => (v ? !Number.isNaN(Number(v)) : true), 'RATE_LIMIT_POST_CREATE_TTL_SECONDS must be a number'),
  RATE_LIMIT_POST_CREATE_LIMIT: z
    .string()
    .optional()
    .refine((v) => (v ? !Number.isNaN(Number(v)) : true), 'RATE_LIMIT_POST_CREATE_LIMIT must be a number'),

  RATE_LIMIT_INTERACT_TTL_SECONDS: z
    .string()
    .optional()
    .refine((v) => (v ? !Number.isNaN(Number(v)) : true), 'RATE_LIMIT_INTERACT_TTL_SECONDS must be a number'),
  RATE_LIMIT_INTERACT_LIMIT: z
    .string()
    .optional()
    .refine((v) => (v ? !Number.isNaN(Number(v)) : true), 'RATE_LIMIT_INTERACT_LIMIT must be a number'),

  RATE_LIMIT_UPLOAD_TTL_SECONDS: z
    .string()
    .optional()
    .refine((v) => (v ? !Number.isNaN(Number(v)) : true), 'RATE_LIMIT_UPLOAD_TTL_SECONDS must be a number'),
  RATE_LIMIT_UPLOAD_LIMIT: z
    .string()
    .optional()
    .refine((v) => (v ? !Number.isNaN(Number(v)) : true), 'RATE_LIMIT_UPLOAD_LIMIT must be a number'),

  // Express / proxy settings (recommended in production behind a reverse proxy / Cloudflare).
  // When enabled, Express will respect X-Forwarded-* headers for req.ip / req.protocol.
  TRUST_PROXY: z.preprocess(
    (v) => (typeof v === 'string' && v.trim() === '' ? undefined : v),
    z.string().optional(),
  ),

  // Body size limits (protects memory + prevents accidental huge payloads).
  BODY_JSON_LIMIT: z.preprocess(
    (v) => (typeof v === 'string' && v.trim() === '' ? undefined : v),
    z.string().optional().default('1mb'),
  ),
  BODY_URLENCODED_LIMIT: z.preprocess(
    (v) => (typeof v === 'string' && v.trim() === '' ? undefined : v),
    z.string().optional().default('25kb'),
  ),

  // CSRF hardening (cookie auth): require Origin/Referer on unsafe methods in production.
  REQUIRE_CSRF_ORIGIN_IN_PROD: z.preprocess(
    (v) => (typeof v === 'string' && v.trim() === '' ? undefined : v),
    z.string().optional().default('true'),
  ),

  // Dev-only: log every request (method, path, status, ms, request-id).
  LOG_REQUESTS: z.preprocess(
    (v) => (typeof v === 'string' && v.trim() === '' ? undefined : v),
    z.string().optional(),
  ),

  // Dev-only: print startup config summary (opt-in).
  LOG_STARTUP_INFO: z.preprocess(
    (v) => (typeof v === 'string' && v.trim() === '' ? undefined : v),
    z.string().optional(),
  ),

  // Presence: minutes with no activity ping before marking user idle (default 3).
  PRESENCE_IDLE_AFTER_MINUTES: z
    .string()
    .optional()
    .refine((v) => (v ? !Number.isNaN(Number(v)) : true), 'PRESENCE_IDLE_AFTER_MINUTES must be a number'),
  // Presence: if user stays idle this many minutes, disconnect them (consider offline and close socket).
  PRESENCE_IDLE_DISCONNECT_MINUTES: z
    .string()
    .optional()
    .refine((v) => (v ? !Number.isNaN(Number(v)) : true), 'PRESENCE_IDLE_DISCONNECT_MINUTES must be a number'),

  // Web Push (browser notifications). Generate: npx web-push generate-vapid-keys
  VAPID_PUBLIC_KEY: z.preprocess(
    (v) => (typeof v === 'string' && v.trim() === '' ? undefined : v),
    z.string().optional(),
  ),
  VAPID_PRIVATE_KEY: z.preprocess(
    (v) => (typeof v === 'string' && v.trim() === '' ? undefined : v),
    z.string().optional(),
  ),
  // Base URL for push notification click-through (canonical frontend). If unset, first ALLOWED_ORIGINS entry is used.
  PUSH_FRONTEND_BASE_URL: z.preprocess(
    (v) => (typeof v === 'string' && v.trim() === '' ? undefined : v),
    z.string().optional(),
  ),

  // Stripe billing (Premium / Premium+ subscriptions)
  STRIPE_SECRET_KEY: z.preprocess(
    (v) => (typeof v === 'string' && v.trim() === '' ? undefined : v),
    z.string().optional(),
  ),
  STRIPE_WEBHOOK_SECRET: z.preprocess(
    (v) => (typeof v === 'string' && v.trim() === '' ? undefined : v),
    z.string().optional(),
  ),
  STRIPE_PRICE_PREMIUM_MONTHLY: z.preprocess(
    (v) => (typeof v === 'string' && v.trim() === '' ? undefined : v),
    z.string().optional(),
  ),
  STRIPE_PRICE_PREMIUM_PLUS_MONTHLY: z.preprocess(
    (v) => (typeof v === 'string' && v.trim() === '' ? undefined : v),
    z.string().optional(),
  ),

  // Email (optional): configure Mailgun for digests/re-engagement.
  // Email (optional): Resend (digests + verification + nudges).
  RESEND_API_KEY: z.preprocess(
    (v) => (typeof v === 'string' && v.trim() === '' ? undefined : v),
    z.string().optional(),
  ),
  RESEND_FROM_EMAIL: z.preprocess(
    (v) => (typeof v === 'string' && v.trim() === '' ? undefined : v),
    z.string().optional(),
  ),
  RESEND_FROM_NOTIFICATIONS_EMAIL: z.preprocess(
    (v) => (typeof v === 'string' && v.trim() === '' ? undefined : v),
    z.string().optional(),
  ),
  RESEND_FROM_SUPPORT_EMAIL: z.preprocess(
    (v) => (typeof v === 'string' && v.trim() === '' ? undefined : v),
    z.string().optional(),
  ),

  // Slack Incoming Webhook URL (optional; notifications silently no-op when unset).
  // Create one at: https://api.slack.com/apps → your app → Incoming Webhooks
  SLACK_WEBHOOK_URL: z.preprocess(
    (v) => (typeof v === 'string' && v.trim() === '' ? undefined : v),
    z.string().optional(),
  ),

  // PostHog product analytics (optional; events silently no-op when unset)
  POSTHOG_API_KEY: z.preprocess(
    (v) => (typeof v === 'string' && v.trim() === '' ? undefined : v),
    z.string().optional(),
  ),
  POSTHOG_HOST: z.preprocess(
    (v) => (typeof v === 'string' && v.trim() === '' ? undefined : v),
    z.string().optional().default('https://us.i.posthog.com'),
  ),

  // ─── Marv (AI helper) ────────────────────────────────────────────────────
  // Global on/off. Defaults to true; admin UI can override via MarvinGlobalSettings row.
  MARV_ENABLED: z.preprocess(
    (v) => (typeof v === 'string' && v.trim() === '' ? undefined : v),
    z.string().optional().default('true'),
  ),
  // Optional override of the Marv bot user id. When unset, MarvinSeedService
  // creates/looks up the user by MARV_USERNAME and caches the id in memory.
  MARV_USER_ID: z.preprocess(
    (v) => (typeof v === 'string' && v.trim() === '' ? undefined : v),
    z.string().optional(),
  ),
  MARV_USERNAME: z.preprocess(
    (v) => (typeof v === 'string' && v.trim() === '' ? undefined : v),
    z.string().optional().default('marv'),
  ),
  MARV_DISPLAY_NAME: z.preprocess(
    (v) => (typeof v === 'string' && v.trim() === '' ? undefined : v),
    z.string().optional().default('Marv'),
  ),
  MARV_BIO: z.preprocess(
    (v) => (typeof v === 'string' && v.trim() === '' ? undefined : v),
    z.string().optional().default('AI helper for Men of Hunger. Brief. Bible-conscious. Mention me to ask.'),
  ),
  // Marv phone (Marv is a real User; users have unique phones). Use a
  // recognizable bot-only number so it never collides with a real signup.
  MARV_PHONE: z.preprocess(
    (v) => (typeof v === 'string' && v.trim() === '' ? undefined : v),
    z.string().optional().default('+10000000001'),
  ),

  // OpenAI Responses API. Personality (system prompt + tool schemas) lives in a Stored
  // Prompt on OpenAI; we override the model per request via the Fast/Regular/Smart router.
  OPENAI_API_KEY: z.preprocess(
    (v) => (typeof v === 'string' && v.trim() === '' ? undefined : v),
    z.string().optional(),
  ),
  OPENAI_MARV_PROMPT_ID: z.preprocess(
    (v) => (typeof v === 'string' && v.trim() === '' ? undefined : v),
    z.string().optional(),
  ),
  OPENAI_MARV_PROMPT_VERSION: z.preprocess(
    (v) => (typeof v === 'string' && v.trim() === '' ? undefined : v),
    z.string().optional(),
  ),
  OPENAI_MARV_FAST_MODEL: z.preprocess(
    (v) => (typeof v === 'string' && v.trim() === '' ? undefined : v),
    z.string().optional().default(MARV_DEFAULT_FAST_MODEL),
  ),
  OPENAI_MARV_REGULAR_MODEL: z.preprocess(
    (v) => (typeof v === 'string' && v.trim() === '' ? undefined : v),
    z.string().optional().default(MARV_DEFAULT_REGULAR_MODEL),
  ),
  OPENAI_MARV_SMART_MODEL: z.preprocess(
    (v) => (typeof v === 'string' && v.trim() === '' ? undefined : v),
    z.string().optional().default(MARV_DEFAULT_SMART_MODEL),
  ),

  // Credit bucket — see MarvinCreditService.
  MARV_MONTHLY_CREDITS: z
    .string()
    .optional()
    .refine((v) => (v ? !Number.isNaN(Number(v)) : true), 'MARV_MONTHLY_CREDITS must be a number'),
  MARV_MAX_CREDITS: z
    .string()
    .optional()
    .refine((v) => (v ? !Number.isNaN(Number(v)) : true), 'MARV_MAX_CREDITS must be a number'),
  MARV_CREDITS_PER_DAY: z
    .string()
    .optional()
    .refine((v) => (v ? !Number.isNaN(Number(v)) : true), 'MARV_CREDITS_PER_DAY must be a number'),
  MARV_FAST_COST: z
    .string()
    .optional()
    .refine((v) => (v ? !Number.isNaN(Number(v)) : true), 'MARV_FAST_COST must be a number'),
  MARV_REGULAR_COST: z
    .string()
    .optional()
    .refine((v) => (v ? !Number.isNaN(Number(v)) : true), 'MARV_REGULAR_COST must be a number'),
  MARV_SMART_COST: z
    .string()
    .optional()
    .refine((v) => (v ? !Number.isNaN(Number(v)) : true), 'MARV_SMART_COST must be a number'),

  // Token caps (passed to the Responses API max_output_tokens + used to clamp prompt assembly).
  MARV_PUBLIC_MAX_INPUT_TOKENS: z
    .string()
    .optional()
    .refine((v) => (v ? !Number.isNaN(Number(v)) : true), 'MARV_PUBLIC_MAX_INPUT_TOKENS must be a number'),
  MARV_PRIVATE_MAX_INPUT_TOKENS: z
    .string()
    .optional()
    .refine((v) => (v ? !Number.isNaN(Number(v)) : true), 'MARV_PRIVATE_MAX_INPUT_TOKENS must be a number'),
  MARV_MAX_OUTPUT_TOKENS: z
    .string()
    .optional()
    .refine((v) => (v ? !Number.isNaN(Number(v)) : true), 'MARV_MAX_OUTPUT_TOKENS must be a number'),

  // Rate limits (separate from the global throttler — these are enforced inside the job).
  MARV_PUBLIC_MAX_PER_USER_PER_HOUR: z
    .string()
    .optional()
    .refine((v) => (v ? !Number.isNaN(Number(v)) : true), 'MARV_PUBLIC_MAX_PER_USER_PER_HOUR must be a number'),
  MARV_PUBLIC_MAX_PER_USER_PER_DAY: z
    .string()
    .optional()
    .refine((v) => (v ? !Number.isNaN(Number(v)) : true), 'MARV_PUBLIC_MAX_PER_USER_PER_DAY must be a number'),
  MARV_PUBLIC_THREAD_BURST_LIMIT: z
    .string()
    .optional()
    .refine((v) => (v ? !Number.isNaN(Number(v)) : true), 'MARV_PUBLIC_THREAD_BURST_LIMIT must be a number'),
  MARV_PUBLIC_THREAD_BURST_WINDOW_SECONDS: z
    .string()
    .optional()
    .refine(
      (v) => (v ? !Number.isNaN(Number(v)) : true),
      'MARV_PUBLIC_THREAD_BURST_WINDOW_SECONDS must be a number',
    ),
  MARV_PRIVATE_MAX_PER_USER_PER_DAY: z
    .string()
    .optional()
    .refine((v) => (v ? !Number.isNaN(Number(v)) : true), 'MARV_PRIVATE_MAX_PER_USER_PER_DAY must be a number'),
  MARV_PRIVATE_MAX_PER_10_MIN: z
    .string()
    .optional()
    .refine((v) => (v ? !Number.isNaN(Number(v)) : true), 'MARV_PRIVATE_MAX_PER_10_MIN must be a number'),

  // Marv web search (optional — gates web_search_preview tool attachment).
  MARV_WEB_SEARCH_ENABLED: z.preprocess(
    (v) => (typeof v === 'string' && v.trim() === '' ? undefined : v),
    z.string().optional(),
  ),
  MARV_WEB_SEARCH_MODES: z.preprocess(
    (v) => (typeof v === 'string' && v.trim() === '' ? undefined : v),
    z.string().optional(),
  ),
  MARV_WEB_SEARCH_MAX_OUTPUT_TOKENS: z
    .string()
    .optional()
    .refine((v) => (v ? !Number.isNaN(Number(v)) : true), 'MARV_WEB_SEARCH_MAX_OUTPUT_TOKENS must be a number'),
  MARV_WEB_SEARCH_CREDIT_COST: z
    .string()
    .optional()
    .refine((v) => (v ? !Number.isNaN(Number(v)) : true), 'MARV_WEB_SEARCH_CREDIT_COST must be a number'),

  // Marv vision (optional — gates image/GIF inputs to OpenAI). Requires a model that supports vision.
  MARV_VISION_ENABLED: z.preprocess(
    (v) => (typeof v === 'string' && v.trim() === '' ? undefined : v),
    z.string().optional(),
  ),
  // Comma-separated modes that may receive image inputs. Defaults to regular,smart — gpt-5.4-nano
  // cannot reliably process images within its token budget.
  MARV_VISION_MODES: z.preprocess(
    (v) => (typeof v === 'string' && v.trim() === '' ? undefined : v),
    z.string().optional(),
  ),
  MARV_VISION_MAX_IMAGES_PER_TURN: z
    .string()
    .optional()
    .refine((v) => (v ? !Number.isNaN(Number(v)) && Number(v) > 0 : true), 'MARV_VISION_MAX_IMAGES_PER_TURN must be a positive number'),
  MARV_VISION_CREDIT_COST_PER_IMAGE: z
    .string()
    .optional()
    .refine((v) => (v ? !Number.isNaN(Number(v)) : true), 'MARV_VISION_CREDIT_COST_PER_IMAGE must be a number'),

  // BullMQ worker concurrency for the dedicated Marv queue. Marv replies are I/O-bound
  // (waiting on OpenAI), so concurrency >> 1 is safe and necessary — the default queue
  // worker would serialize all replies behind cron sweeps. Sized for ~50–200 simultaneous
  // premium users at peak; lower it if you see OpenAI rate-limit errors.
  MARV_QUEUE_CONCURRENCY: z
    .string()
    .optional()
    .refine((v) => (v ? !Number.isNaN(Number(v)) && Number(v) > 0 : true), 'MARV_QUEUE_CONCURRENCY must be a positive number'),
}).superRefine((env, ctx) => {
  if (env.NODE_ENV !== 'production') return;

  if (!env.OTP_HMAC_SECRET || env.OTP_HMAC_SECRET.length < 16) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['OTP_HMAC_SECRET'],
      message: 'OTP_HMAC_SECRET is required in production (min 16 chars)',
    });
  }

  if (!env.SESSION_HMAC_SECRET || env.SESSION_HMAC_SECRET.length < 16) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['SESSION_HMAC_SECRET'],
      message: 'SESSION_HMAC_SECRET is required in production (min 16 chars)',
    });
  }

  if (!env.REDIS_URL || !String(env.REDIS_URL).trim()) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['REDIS_URL'],
      message: 'REDIS_URL is required in production',
    });
  }
});

export type Env = z.infer<typeof envSchema>;

export function validateEnv<TSchema extends z.ZodTypeAny>(schema: TSchema) {
  return (config: Record<string, unknown>) => {
    const parsed = schema.safeParse(config);
    if (!parsed.success) {
      // Nest expects thrown errors to abort bootstrap.
      throw new Error(
        `Invalid environment variables:\n${parsed.error.issues
          .map((i) => `- ${i.path.join('.')}: ${i.message}`)
          .join('\n')}`,
      );
    }
    return parsed.data;
  };
}

