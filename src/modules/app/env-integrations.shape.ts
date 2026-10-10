import { z } from "zod";

/** Third-party integrations: PostHog, Strava, Pickax, X, Sentry, channels. */
export const integrationsEnvShape = {
  // Optional server-only Android FCM service account; all three values enable delivery.
  FCM_PROJECT_ID: z.string().trim().optional(),
  FCM_CLIENT_EMAIL: z.string().trim().optional(),
  FCM_PRIVATE_KEY: z.string().optional(),
    // PostHog product analytics (optional; events silently no-op when unset)
    // ─── Strava integration ─────────────────────────────────────────────────
    STRAVA_CLIENT_ID: z.preprocess(
      (v) => (typeof v === "string" && v.trim() === "" ? undefined : v),
      z.string().optional(),
    ),
    STRAVA_CLIENT_SECRET: z.preprocess(
      (v) => (typeof v === "string" && v.trim() === "" ? undefined : v),
      z.string().optional(),
    ),
    STRAVA_WEBHOOK_VERIFY_TOKEN: z.preprocess(
      (v) => (typeof v === "string" && v.trim() === "" ? undefined : v),
      z.string().optional(),
    ),

    // Encrypts members' Pickax API credentials at rest (min 32 chars). Cross-posting is off when unset.
    PICKAX_SECRET_ENCRYPTION_KEY: z.preprocess(
      (v) => (typeof v === "string" && v.trim() === "" ? undefined : v),
      z.string().min(32).optional(),
    ),

    // X (Twitter) OAuth cross-posting. Off until the client id, secret, and encryption key are set.
    X_CLIENT_ID: z.preprocess(
      (v) => (typeof v === "string" && v.trim() === "" ? undefined : v),
      z.string().optional(),
    ),
    X_CLIENT_SECRET: z.preprocess(
      (v) => (typeof v === "string" && v.trim() === "" ? undefined : v),
      z.string().optional(),
    ),
    X_TOKEN_ENCRYPTION_KEY: z.preprocess(
      (v) => (typeof v === "string" && v.trim() === "" ? undefined : v),
      z.string().min(32).optional(),
    ),
    X_MONTHLY_BUDGET_CENTS: z.preprocess(
      (v) => (typeof v === "string" && v.trim() === "" ? undefined : v),
      z.coerce.number().int().min(0).max(100_000).optional().default(300),
    ),

    POSTHOG_API_KEY: z.preprocess(
      (v) => (typeof v === "string" && v.trim() === "" ? undefined : v),
      z.string().optional(),
    ),
    POSTHOG_HOST: z.preprocess(
      (v) => (typeof v === "string" && v.trim() === "" ? undefined : v),
      z.string().optional().default("https://us.i.posthog.com"),
    ),
    POSTHOG_FEATURE_FLAGS_KEY: z.preprocess(
      (v) => (typeof v === "string" && v.trim() === "" ? undefined : v),
      z.string().optional(),
    ),

    // Sentry error + performance monitoring (optional; disabled when SENTRY_DSN is unset).
    // Read directly in src/instrument.ts, which runs before Nest config is available.
    SENTRY_DSN: z.preprocess(
      (v) => (typeof v === "string" && v.trim() === "" ? undefined : v),
      z.string().url().optional(),
    ),
    SENTRY_ENVIRONMENT: z.preprocess(
      (v) => (typeof v === "string" && v.trim() === "" ? undefined : v),
      z.string().optional(),
    ),
    SENTRY_TRACES_SAMPLE_RATE: z.preprocess(
      (v) => (typeof v === "string" && v.trim() === "" ? undefined : v),
      z.coerce.number().min(0).max(1).optional(),
    ),

    // Channels stay disabled until client and privacy acceptance gates pass.
  GROUP_CHANNELS_ENABLED: z.enum(["true", "false"]).default("true"),
    GROUP_CHANNELS_GROUP_IDS: z.string().default(""),
    AUDIO_TRANSCRIPTION_ENABLED: z.enum(["true", "false"]).default("false"),
    OPENAI_TRANSCRIBE_MODEL: z.preprocess(
      (v) => (typeof v === "string" && v.trim() === "" ? undefined : v),
      z.string().optional().default("gpt-4o-transcribe"),
    ),

};
