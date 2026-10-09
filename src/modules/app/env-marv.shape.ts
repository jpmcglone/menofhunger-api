import { z } from "zod";
import { MARV_DEFAULT_ASTRA_MODEL, MARV_DEFAULT_FAST_MODEL, MARV_DEFAULT_REGULAR_MODEL, MARV_DEFAULT_SMART_MODEL } from "../marvin/marvin-models";

/** Marv (AI helper), embeddings, moderation, and OpenAI environment variables. */
export const marvEnvShape = {
    // ─── Marv (AI helper) ────────────────────────────────────────────────────
    // Global on/off. Defaults to true; admin UI can override via MarvinGlobalSettings row.
    MARV_ENABLED: z.preprocess(
      (v) => (typeof v === "string" && v.trim() === "" ? undefined : v),
      z.string().optional().default("true"),
    ),
    // Optional override of the Marv bot user id. When unset, MarvinSeedService
    // creates/looks up the user by MARV_USERNAME and caches the id in memory.
    MARV_USER_ID: z.preprocess(
      (v) => (typeof v === "string" && v.trim() === "" ? undefined : v),
      z.string().optional(),
    ),
    MARV_USERNAME: z.preprocess(
      (v) => (typeof v === "string" && v.trim() === "" ? undefined : v),
      z.string().optional().default("marv"),
    ),
    MARV_DISPLAY_NAME: z.preprocess(
      (v) => (typeof v === "string" && v.trim() === "" ? undefined : v),
      z.string().optional().default("Marv"),
    ),
    MARV_BIO: z.preprocess(
      (v) => (typeof v === "string" && v.trim() === "" ? undefined : v),
      z
        .string()
        .optional()
        .default(
          "AI helper for Men of Hunger. Brief. Bible-conscious. Mention me to ask.",
        ),
    ),
    // Marv phone (Marv is a real User; users have unique phones). Use a
    // recognizable bot-only number so it never collides with a real signup.
    MARV_PHONE: z.preprocess(
      (v) => (typeof v === "string" && v.trim() === "" ? undefined : v),
      z.string().optional().default("+10000000001"),
    ),

    // TypeSafe AI (Jev): typed decisions with calibrated probabilities. Unset disables it.
    TYPESAFE_API_KEY: z.preprocess(
      (v) => (typeof v === "string" && v.trim() === "" ? undefined : v),
      z.string().optional(),
    ),
    TYPESAFE_MODEL: z.preprocess(
      (v) => (typeof v === "string" && v.trim() === "" ? undefined : v),
      z.string().optional().default("jev-latest"),
    ),
    TYPESAFE_TIMEOUT_MS: z.preprocess(
      (v) => (typeof v === "string" && v.trim() === "" ? undefined : v),
      z.coerce.number().int().positive().optional(),
    ),
    TYPESAFE_DAILY_BUDGET_USD: z.preprocess(
      (v) => (typeof v === "string" && v.trim() === "" ? undefined : v),
      z.coerce.number().nonnegative().optional(),
    ),
    TYPESAFE_INPUT_USD_PER_MILLION_TOKENS: z.preprocess(
      (v) => (typeof v === "string" && v.trim() === "" ? undefined : v),
      z.coerce.number().positive().optional(),
    ),
    TYPESAFE_ROUTING_ENABLED: z.enum(["true", "false"]).default("true"),
    TYPESAFE_REPLY_GATE_ENABLED: z.enum(["true", "false"]).default("true"),
    TYPESAFE_ADDRESSING_ENABLED: z.enum(["true", "false"]).default("true"),
    TYPESAFE_TRIAGE_ENABLED: z.enum(["true", "false"]).default("true"),

    // Semantic search, related content, and matching. Uses OPENAI_API_KEY; set EMBEDDINGS_ENABLED=false to turn off.
    // Free OpenAI moderation check on posts from new accounts or posts with links. Flags go to the admin report queue.
    CONTENT_SCREEN_ENABLED: z.enum(["true", "false"]).default("true"),
    EMBEDDINGS_ENABLED: z.enum(["true", "false"]).default("true"),
    OPENAI_EMBEDDING_MODEL: z.preprocess(
      (v) => (typeof v === "string" && v.trim() === "" ? undefined : v),
      z.string().optional(),
    ),
    EMBEDDINGS_DAILY_BUDGET_USD: z.preprocess(
      (v) => (typeof v === "string" && v.trim() === "" ? undefined : v),
      z.coerce.number().nonnegative().optional(),
    ),
    EMBEDDINGS_USD_PER_MILLION_TOKENS: z.preprocess(
      (v) => (typeof v === "string" && v.trim() === "" ? undefined : v),
      z.coerce.number().positive().optional(),
    ),

    // OpenAI Responses API. Member Marv personality lives in code
    // (`marvin-system-prompt.ts`) and is sent as `instructions`. Need an API key.
    OPENAI_API_KEY: z.preprocess(
      (v) => (typeof v === "string" && v.trim() === "" ? undefined : v),
      z.string().optional(),
    ),
    // Ignored. Kept so existing deployments can leave the old stored-prompt env
    // vars set without failing validation. Remove after the next env cleanup.
    OPENAI_MARV_PROMPT_ID: z.preprocess(
      (v) => (typeof v === "string" && v.trim() === "" ? undefined : v),
      z.string().optional(),
    ),
    OPENAI_MARV_PROMPT_VERSION: z.preprocess(
      (v) => (typeof v === "string" && v.trim() === "" ? undefined : v),
      z.string().optional(),
    ),
    OPENAI_MARV_FAST_MODEL: z.preprocess(
      (v) => (typeof v === "string" && v.trim() === "" ? undefined : v),
      z.string().optional().default(MARV_DEFAULT_FAST_MODEL),
    ),
    OPENAI_MARV_REGULAR_MODEL: z.preprocess(
      (v) => (typeof v === "string" && v.trim() === "" ? undefined : v),
      z.string().optional().default(MARV_DEFAULT_REGULAR_MODEL),
    ),
    OPENAI_MARV_SMART_MODEL: z.preprocess(
      (v) => (typeof v === "string" && v.trim() === "" ? undefined : v),
      z.string().optional().default(MARV_DEFAULT_SMART_MODEL),
    ),
    OPENAI_ADMIN_ASTRA_MODEL: z.preprocess(
      (v) => (typeof v === "string" && v.trim() === "" ? undefined : v),
      z.string().optional().default(MARV_DEFAULT_ASTRA_MODEL),
    ),

    // Credit bucket — see MarvinCreditService.
    MARV_MONTHLY_CREDITS: z
      .string()
      .optional()
      .refine(
        (v) => (v ? !Number.isNaN(Number(v)) : true),
        "MARV_MONTHLY_CREDITS must be a number",
      ),
    MARV_MAX_CREDITS: z
      .string()
      .optional()
      .refine(
        (v) => (v ? !Number.isNaN(Number(v)) : true),
        "MARV_MAX_CREDITS must be a number",
      ),
    MARV_CREDITS_PER_DAY: z
      .string()
      .optional()
      .refine(
        (v) => (v ? !Number.isNaN(Number(v)) : true),
        "MARV_CREDITS_PER_DAY must be a number",
      ),
    MARV_FAST_COST: z
      .string()
      .optional()
      .refine(
        (v) => (v ? !Number.isNaN(Number(v)) : true),
        "MARV_FAST_COST must be a number",
      ),
    MARV_REGULAR_COST: z
      .string()
      .optional()
      .refine(
        (v) => (v ? !Number.isNaN(Number(v)) : true),
        "MARV_REGULAR_COST must be a number",
      ),
    MARV_SMART_COST: z
      .string()
      .optional()
      .refine(
        (v) => (v ? !Number.isNaN(Number(v)) : true),
        "MARV_SMART_COST must be a number",
      ),

    // Token caps (passed to the Responses API max_output_tokens + used to clamp prompt assembly).
    MARV_PUBLIC_MAX_INPUT_TOKENS: z
      .string()
      .optional()
      .refine(
        (v) => (v ? !Number.isNaN(Number(v)) : true),
        "MARV_PUBLIC_MAX_INPUT_TOKENS must be a number",
      ),
    MARV_PRIVATE_MAX_INPUT_TOKENS: z
      .string()
      .optional()
      .refine(
        (v) => (v ? !Number.isNaN(Number(v)) : true),
        "MARV_PRIVATE_MAX_INPUT_TOKENS must be a number",
      ),
    MARV_MAX_OUTPUT_TOKENS: z
      .string()
      .optional()
      .refine(
        (v) => (v ? !Number.isNaN(Number(v)) : true),
        "MARV_MAX_OUTPUT_TOKENS must be a number",
      ),

    // Rate limits (separate from the global throttler — these are enforced inside the job).
    MARV_PUBLIC_MAX_PER_USER_PER_HOUR: z
      .string()
      .optional()
      .refine(
        (v) => (v ? !Number.isNaN(Number(v)) : true),
        "MARV_PUBLIC_MAX_PER_USER_PER_HOUR must be a number",
      ),
    MARV_PUBLIC_MAX_PER_USER_PER_DAY: z
      .string()
      .optional()
      .refine(
        (v) => (v ? !Number.isNaN(Number(v)) : true),
        "MARV_PUBLIC_MAX_PER_USER_PER_DAY must be a number",
      ),
    MARV_PUBLIC_THREAD_BURST_LIMIT: z
      .string()
      .optional()
      .refine(
        (v) => (v ? !Number.isNaN(Number(v)) : true),
        "MARV_PUBLIC_THREAD_BURST_LIMIT must be a number",
      ),
    MARV_PUBLIC_THREAD_BURST_WINDOW_SECONDS: z
      .string()
      .optional()
      .refine(
        (v) => (v ? !Number.isNaN(Number(v)) : true),
        "MARV_PUBLIC_THREAD_BURST_WINDOW_SECONDS must be a number",
      ),
    MARV_PRIVATE_MAX_PER_USER_PER_DAY: z
      .string()
      .optional()
      .refine(
        (v) => (v ? !Number.isNaN(Number(v)) : true),
        "MARV_PRIVATE_MAX_PER_USER_PER_DAY must be a number",
      ),
    MARV_PRIVATE_MAX_PER_10_MIN: z
      .string()
      .optional()
      .refine(
        (v) => (v ? !Number.isNaN(Number(v)) : true),
        "MARV_PRIVATE_MAX_PER_10_MIN must be a number",
      ),

    // Marv web search (optional — gates hosted web_search tool attachment).
    MARV_WEB_SEARCH_ENABLED: z.preprocess(
      (v) => (typeof v === "string" && v.trim() === "" ? undefined : v),
      z.string().optional(),
    ),
    MARV_WEB_SEARCH_MODES: z.preprocess(
      (v) => (typeof v === "string" && v.trim() === "" ? undefined : v),
      z.string().optional(),
    ),
    MARV_WEB_SEARCH_MAX_OUTPUT_TOKENS: z
      .string()
      .optional()
      .refine(
        (v) => (v ? !Number.isNaN(Number(v)) : true),
        "MARV_WEB_SEARCH_MAX_OUTPUT_TOKENS must be a number",
      ),
    MARV_WEB_SEARCH_CREDIT_COST: z
      .string()
      .optional()
      .refine(
        (v) => (v ? !Number.isNaN(Number(v)) : true),
        "MARV_WEB_SEARCH_CREDIT_COST must be a number",
      ),

    // Marv vision (optional — gates image/GIF inputs to OpenAI). Requires a model that supports vision.
    MARV_VISION_ENABLED: z.preprocess(
      (v) => (typeof v === "string" && v.trim() === "" ? undefined : v),
      z.string().optional(),
    ),
    // Comma-separated modes that may receive image inputs. Default is all three;
    // gpt-5.6-luna handles vision. Web search stays off for fast (see MARV_WEB_SEARCH_MODES).
    MARV_VISION_MODES: z.preprocess(
      (v) => (typeof v === "string" && v.trim() === "" ? undefined : v),
      z.string().optional(),
    ),
    MARV_VISION_MAX_IMAGES_PER_TURN: z
      .string()
      .optional()
      .refine(
        (v) => (v ? !Number.isNaN(Number(v)) && Number(v) > 0 : true),
        "MARV_VISION_MAX_IMAGES_PER_TURN must be a positive number",
      ),
    MARV_VISION_CREDIT_COST_PER_IMAGE: z
      .string()
      .optional()
      .refine(
        (v) => (v ? !Number.isNaN(Number(v)) : true),
        "MARV_VISION_CREDIT_COST_PER_IMAGE must be a number",
      ),

    // BullMQ worker concurrency for the dedicated Marv queue. Marv replies are I/O-bound
    // (waiting on OpenAI), so concurrency >> 1 is safe and necessary — the default queue
    // worker would serialize all replies behind cron sweeps. Sized for ~50–200 simultaneous
    // premium users at peak; lower it if you see OpenAI rate-limit errors.
    MARV_QUEUE_CONCURRENCY: z
      .string()
      .optional()
      .refine(
        (v) => (v ? !Number.isNaN(Number(v)) && Number(v) > 0 : true),
        "MARV_QUEUE_CONCURRENCY must be a positive number",
      ),

    // Read-only member MCP: tool calls per Premium member per UTC day (default 200).
    MCP_MEMBER_DAILY_CALLS: z
      .string()
      .optional()
      .refine(
        (v) => (v ? !Number.isNaN(Number(v)) && Number(v) > 0 : true),
        "MCP_MEMBER_DAILY_CALLS must be a positive number",
      ),

    // Email quota budget — matches the Resend free-tier hard limit (100/day).
    // Upgrade Resend and raise these to remove the constraint.
    // EMAIL_DAILY_QUOTA_LIMIT: total sends allowed per UTC day (default 100).
    EMAIL_DAILY_QUOTA_LIMIT: z
      .string()
      .optional()
      .refine(
        (v) => (v ? !Number.isNaN(Number(v)) && Number(v) > 0 : true),
        "EMAIL_DAILY_QUOTA_LIMIT must be a positive number",
      ),
    // EMAIL_DAILY_VERIFICATION_RESERVE: sends kept in reserve for transactional email (default 15).
    // Engagement sends are blocked once (quota - reserve) is reached.
    EMAIL_DAILY_VERIFICATION_RESERVE: z
      .string()
      .optional()
      .refine(
        (v) => (v ? !Number.isNaN(Number(v)) && Number(v) >= 0 : true),
        "EMAIL_DAILY_VERIFICATION_RESERVE must be a non-negative number",
      ),
    // EMAIL_BROADCAST_DAILY_QUOTA: admin newsletter sends per UTC day (default 5000).
    // Separate from engagement/transactional so a blast cannot starve verification or digests.
    EMAIL_BROADCAST_DAILY_QUOTA: z
      .string()
      .optional()
      .refine(
        (v) => (v ? !Number.isNaN(Number(v)) && Number(v) > 0 : true),
        "EMAIL_BROADCAST_DAILY_QUOTA must be a positive number",
      ),
    // NEWSLETTER_POSTAL_ADDRESS: physical mailing address for CAN-SPAM footer. Required to send.
    NEWSLETTER_POSTAL_ADDRESS: z.string().optional(),

    // Per-publish article fan-out email. Disable (false) on the Resend free tier —
    // new articles already appear in the weekly digest. Enable (true) after upgrading.
    EMAIL_FOLLOWED_ARTICLE_ENABLED: z.preprocess(
      (v) => (typeof v === "string" && v.trim() === "" ? undefined : v),
      z.string().optional().default("false"),
    ),
    // Partner capabilities remain disabled until production credentials and rollout are ready.
    PARTNER_API_ENABLED: z.string().optional().default("false"),
    OUTBOUND_DELIVERY_PAUSED: z.enum(["true", "false"]).default("false"),
    PARTNER_WEBHOOKS_ENABLED: z.string().optional().default("false"),
    PARTNER_OIDC_JWKS: z.string().optional(),
    PARTNER_ENCRYPTION_KEY: z.string().optional(),
    PICKAX_PARTNER_CLIENT_ID: z.string().optional(),
    PICKAX_OAUTH_ISSUER: z.string().url().optional(),
    PICKAX_OAUTH_CLIENT_ID: z.string().optional(),
    PICKAX_OAUTH_CLIENT_SECRET: z.string().optional(),
    PICKAX_OAUTH_ENABLED: z.string().optional().default("false"),
    PICKAX_REMOTE_DELETE_ENABLED: z.string().optional().default("false"),
    X_COUNT_ALLOWANCE_ENABLED: z.string().optional().default("false"),
    INTEGRATION_BUDGET_ENABLED: z.enum(["true", "false"]).default("false"),
    INTEGRATION_COMPANY_MONTHLY_MICROS: z.coerce
      .number()
      .int()
      .min(0)
      .max(2_000_000_000)
      .default(0),
    INTEGRATION_COMPANY_DAILY_MICROS: z.coerce
      .number()
      .int()
      .min(0)
      .max(2_000_000_000)
      .default(0),
    INTEGRATION_REMOVAL_HEADROOM_MICROS: z.coerce
      .number()
      .int()
      .min(0)
      .max(2_000_000_000)
      .default(0),
    INTEGRATION_X_MONTHLY_MICROS: z.coerce
      .number()
      .int()
      .min(0)
      .max(2_000_000_000)
      .default(0),
    INTEGRATION_FUNDED_RESERVE_MICROS: z.coerce
      .number()
      .int()
      .min(0)
      .max(2_000_000_000)
      .default(0),
    INTEGRATION_ACQUISITION_MICROS: z.coerce
      .number()
      .int()
      .min(0)
      .max(2_000_000_000)
      .default(0),
    INTEGRATION_X_PRICE_VERSION: z.string().max(100).default(""),
    X_ARTICLE_ENABLED: z.enum(["true", "false"]).default("false"),
    X_ARTICLE_ACCOUNT_IDS: z.string().max(4000).optional(),
    X_ARTICLE_MAX_MICROS: z.preprocess(
      (value) =>
        typeof value === "string" && !value.trim() ? undefined : value,
      z.coerce.number().int().min(0).max(10_000_000).optional(),
    ),
    X_ARTICLE_PRICE_VERSION: z.string().max(100).optional(),
    X_ARTICLE_BUCKET: z.enum(["regular", "expensive"]).default("regular"),
    X_NEWS_ENABLED: z.enum(["true", "false"]).default("false"),
    X_NEWS_PILOT_START: z.string().datetime().optional(),
    X_NEWS_ACCOUNT_USER_ID: z.string().max(100).optional(),
    X_NEWS_QUERY: z.string().trim().min(1).max(2048).optional(),
    X_NEWS_REQUEST_MAX_MICROS: z.preprocess(
      (value) =>
        typeof value === "string" && !value.trim() ? undefined : value,
      z.coerce.number().int().min(0).max(10_000_000).optional(),
    ),
    X_NEWS_PRICE_VERSION: z.string().max(100).optional(),
    X_PROFILE_CONTEXT_ENABLED: z.enum(["true", "false"]).default("false"),
    X_PROFILE_PREVIEW_ENABLED: z.enum(["true", "false"]).default("false"),
    X_ADVANCED_ENABLED: z.enum(["true", "false"]).default("false"),
    X_ADVANCED_ACCOUNT_IDS: z.string().default(""),
    X_QUOTE_ENTERPRISE_ACCOUNT_IDS: z.string().default(""),
    X_LONG_TEXT_ACCOUNT_IDS: z.string().default(""),
    X_EDIT_ACCOUNT_IDS: z.string().default(""),
    X_ADVANCED_PRICE_VERSION: z.string().default(""),
    X_ADVANCED_POST_MAX_MICROS: z.preprocess(
      (v) => (typeof v === "string" && !v.trim() ? undefined : v),
      z.coerce.number().int().min(0).max(10_000_000).optional(),
    ),
    X_ADVANCED_MEDIA_MAX_MICROS: z.preprocess(
      (v) => (typeof v === "string" && !v.trim() ? undefined : v),
      z.coerce.number().int().min(0).max(10_000_000).optional(),
    ),
    X_IMAGE_UPLOAD_MAX_MICROS: z.preprocess(
      (value) =>
        typeof value === "string" && !value.trim() ? undefined : value,
      z.coerce.number().int().min(0).max(1_000_000).optional(),
    ),
};
