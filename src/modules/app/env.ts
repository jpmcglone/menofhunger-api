import { z } from 'zod';

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
  MAILGUN_API_KEY: z.preprocess(
    (v) => (typeof v === 'string' && v.trim() === '' ? undefined : v),
    z.string().optional(),
  ),
  MAILGUN_DOMAIN: z.preprocess(
    (v) => (typeof v === 'string' && v.trim() === '' ? undefined : v),
    z.string().optional(),
  ),
  MAILGUN_FROM_EMAIL: z.preprocess(
    (v) => (typeof v === 'string' && v.trim() === '' ? undefined : v),
    z.string().optional(),
  ),
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

