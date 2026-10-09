import { MARV_DEFAULT_ASTRA_MODEL, MARV_DEFAULT_FAST_MODEL, MARV_DEFAULT_REGULAR_MODEL, MARV_DEFAULT_SMART_MODEL } from "../marvin/marvin-models";
import type { Env } from "./env";
import type { MarvBotConfig, MarvCreditConfig, MarvLimitsConfig, MarvOpenAIConfig, TypeSafeConfig } from "./app-config.types";
import { AppConfigBaseValues } from "./app-config-base.values";

/** Marv, TypeSafe, embeddings, SEC tickers, and env snapshot config accessors. */
export class AppConfigValues extends AppConfigBaseValues {

  marvBot(): MarvBotConfig {
    const enabled = this.readBool("MARV_ENABLED", true);
    const userId = this.config.get<string>("MARV_USER_ID")?.trim() || null;
    const username = this.config.get<string>("MARV_USERNAME")?.trim() || "marv";
    const displayName =
      this.config.get<string>("MARV_DISPLAY_NAME")?.trim() || "Marv";
    const bio =
      this.config.get<string>("MARV_BIO")?.trim() ||
      "AI helper for Men of Hunger. Brief. Bible-conscious. Mention me to ask.";
    const phone =
      this.config.get<string>("MARV_PHONE")?.trim() || "+10000000001";
    return { enabled, userId, username, displayName, bio, phone };
  }

  /** True when the variable has a non-blank value. Reports presence only, never the value. */
  envIsSet(name: string): boolean {
    return Boolean(this.config.get<string>(name)?.toString().trim());
  }

  typeSafe(): TypeSafeConfig {
    return {
      apiKey: this.config.get<string>("TYPESAFE_API_KEY")?.trim() ?? "",
      model: this.config.get<string>("TYPESAFE_MODEL")?.trim() || "jev-latest",
      timeoutMs: this.readPositiveInt("TYPESAFE_TIMEOUT_MS", 10_000),
      dailyBudgetUsd: Math.max(0, Number(this.config.get<string>("TYPESAFE_DAILY_BUDGET_USD") ?? 1) || 0),
      inputUsdPerMillionTokens: Math.max(0.000001, Number(this.config.get<string>("TYPESAFE_INPUT_USD_PER_MILLION_TOKENS") ?? 0.42) || 0.42),
      routingEnabled: this.readBool("TYPESAFE_ROUTING_ENABLED", true),
      replyGateEnabled: this.readBool("TYPESAFE_REPLY_GATE_ENABLED", true),
      addressingEnabled: this.readBool("TYPESAFE_ADDRESSING_ENABLED", true),
      triageEnabled: this.readBool("TYPESAFE_TRIAGE_ENABLED", true),
    };
  }

  contentScreen() {
    const apiKey = this.config.get<string>("OPENAI_API_KEY")?.trim() ?? "";
    return { enabled: Boolean(apiKey) && this.readBool("CONTENT_SCREEN_ENABLED", true), apiKey };
  }

  embeddings() {
    const apiKey = this.config.get<string>("OPENAI_API_KEY")?.trim() ?? "";
    return {
      enabled: Boolean(apiKey) && this.readBool("EMBEDDINGS_ENABLED", true),
      apiKey,
      model: this.config.get<string>("OPENAI_EMBEDDING_MODEL")?.trim() || "text-embedding-3-small",
      dimensions: 512,
      dailyBudgetUsd: Math.max(0, Number(this.config.get<string>("EMBEDDINGS_DAILY_BUDGET_USD") ?? 0.5) || 0),
      usdPerMillionTokens: Math.max(0.000001, Number(this.config.get<string>("EMBEDDINGS_USD_PER_MILLION_TOKENS") ?? 0.02) || 0.02),
    };
  }

  marvOpenAI(): MarvOpenAIConfig {
    const apiKey = this.config.get<string>("OPENAI_API_KEY")?.trim() ?? "";
    const fastModel =
      this.config.get<string>("OPENAI_MARV_FAST_MODEL")?.trim() ||
      MARV_DEFAULT_FAST_MODEL;
    const regularModel =
      this.config.get<string>("OPENAI_MARV_REGULAR_MODEL")?.trim() ||
      MARV_DEFAULT_REGULAR_MODEL;
    const smartModel =
      this.config.get<string>("OPENAI_MARV_SMART_MODEL")?.trim() ||
      MARV_DEFAULT_SMART_MODEL;
    const astraModel =
      this.config.get<string>("OPENAI_ADMIN_ASTRA_MODEL")?.trim() ||
      MARV_DEFAULT_ASTRA_MODEL;
    // Web search is ON by default. Set MARV_WEB_SEARCH_ENABLED=false to disable.
    const webSearchEnabled = this.readBool("MARV_WEB_SEARCH_ENABLED", true);
    // Comma-separated list of modes that may use web search. Defaults to regular,smart only —
    // fast (gpt-5.6-luna) plus our 4k output cap often burns the budget on search processing,
    // and the $0.03 search fee dwarfs a Luna turn.
    const webSearchModesRaw =
      this.config.get<string>("MARV_WEB_SEARCH_MODES")?.trim() ||
      "regular,smart";
    const webSearchModes = webSearchModesRaw
      .split(",")
      .map((s) => s.trim().toLowerCase())
      .filter(Boolean);
    // When web search is active, use a larger output-token budget so the model has room to
    // both process search results AND write a reply. Default 4096; tune with MARV_WEB_SEARCH_MAX_OUTPUT_TOKENS.
    const webSearchMaxOutputTokens = this.readPositiveInt(
      "MARV_WEB_SEARCH_MAX_OUTPUT_TOKENS",
      4096,
    );
    // Vision is ON by default. Set MARV_VISION_ENABLED=false to disable.
    const visionEnabled = this.readBool("MARV_VISION_ENABLED", true);
    // All three model tiers support image inputs. Previously only regular,smart was default,
    // which meant auto-routed queries landing on fast would silently drop images and Marv
    // would claim he can't see them. fast (gpt-5.6-luna) handles vision fine; the token-budget
    // concern only applies to web search (see webSearchModes).
    const visionModesRaw =
      this.config.get<string>("MARV_VISION_MODES")?.trim() ||
      "fast,regular,smart";
    const visionModes = visionModesRaw
      .split(",")
      .map((s) => s.trim().toLowerCase())
      .filter(Boolean);
    // Per-turn image budget. Catch-me-up and mentions include EVERY image in the conversation
    // (multiple per post, throughout the thread) up to this cap. Each attached image bills the
    // per-image vision surcharge, so cost scales with count — raise via env if a deployment
    // wants even more. 16 covers a long image-bearing thread; extras still bill per image.
    const visionMaxImagesPerTurn = this.readPositiveInt(
      "MARV_VISION_MAX_IMAGES_PER_TURN",
      16,
    );
    return {
      apiKey,
      fastModel,
      regularModel,
      smartModel,
      astraModel,
      webSearchEnabled,
      webSearchModes,
      webSearchMaxOutputTokens,
      visionEnabled,
      visionModes,
      visionMaxImagesPerTurn,
    };
  }

  marvCredits(): MarvCreditConfig {
    // Premium pays for ACCESS. Credits are a throttle so Marv stays a tool, not a
    // companion — high margin on the subscription, honest relative prices on usage.
    // Existing balances above the new cap clip on the next refill.
    return {
      monthlyCredits: this.readPositiveInt("MARV_MONTHLY_CREDITS", 600),
      maxCredits: this.readPositiveInt("MARV_MAX_CREDITS", 600),
      creditsPerDay: this.readPositiveInt("MARV_CREDITS_PER_DAY", 20),
      fastCost: this.readPositiveInt("MARV_FAST_COST", 1),
      regularCost: this.readPositiveInt("MARV_REGULAR_COST", 2),
      // Smart (gpt-5.6-sol, ~$0.016/req) vs regular (gpt-5.6-terra, ~$0.009/req)
      // at ~2k in / 400 out. Credit ladder stays 1/2/5 — a gentler throttle than
      // the ~1:10:20 API-price ratio, so Smart stays usable.
      smartCost: this.readPositiveInt("MARV_SMART_COST", 5),
      // Web search is the expensive API (~$0.03/call). Same weight as a Smart turn.
      webSearchCreditCost: this.readPositiveInt(
        "MARV_WEB_SEARCH_CREDIT_COST",
        5,
      ),
      // Vision is cheap (~$0.002/image). One photo should not cost a full reply.
      visionCreditCostPerImage: this.readPositiveInt(
        "MARV_VISION_CREDIT_COST_PER_IMAGE",
        1,
      ),
      // Extra credits per URL fetched via Jina Reader. Jina's public endpoint is free-tier,
      // so 1 credit per fetch keeps it cheap while still accounting for the network overhead.
      urlFetchCreditCost: this.readPositiveInt("MARV_URL_FETCH_CREDIT_COST", 1),
    };
  }

  marvLimits(): MarvLimitsConfig {
    return {
      publicMaxInputTokens: this.readPositiveInt(
        "MARV_PUBLIC_MAX_INPUT_TOKENS",
        8000,
      ),
      privateMaxInputTokens: this.readPositiveInt(
        "MARV_PRIVATE_MAX_INPUT_TOKENS",
        4000,
      ),
      // Cap, not a target — billed tokens follow what the model actually emits.
      // GPT-5.6 Luna/Terra/Sol all allow 128K output; this is a cost/latency cap,
      // not the model limit. Reasoning + tool-call JSON burn this before visible
      // text. 1024 exhausted mid-think on tool-heavy DMs ("tell me about @user"),
      // which surfaced as the canned "something went sideways" reply. 4096 leaves
      // room for a few tool rounds; the 80-word prompt still keeps the visible
      // reply short. Override with MARV_MAX_OUTPUT_TOKENS in .env.
      maxOutputTokens: this.readPositiveInt("MARV_MAX_OUTPUT_TOKENS", 4096),
      publicMaxPerUserPerHour: this.readPositiveInt(
        "MARV_PUBLIC_MAX_PER_USER_PER_HOUR",
        10,
      ),
      publicMaxPerUserPerDay: this.readPositiveInt(
        "MARV_PUBLIC_MAX_PER_USER_PER_DAY",
        30,
      ),
      publicThreadBurstLimit: this.readPositiveInt(
        "MARV_PUBLIC_THREAD_BURST_LIMIT",
        3,
      ),
      publicThreadBurstWindowSeconds: this.readPositiveInt(
        "MARV_PUBLIC_THREAD_BURST_WINDOW_SECONDS",
        60,
      ),
      privateMaxPerUserPerDay: this.readPositiveInt(
        "MARV_PRIVATE_MAX_PER_USER_PER_DAY",
        60,
      ),
      privateMaxPer10Minutes: this.readPositiveInt(
        "MARV_PRIVATE_MAX_PER_10_MIN",
        10,
      ),
      queueConcurrency: this.readPositiveInt("MARV_QUEUE_CONCURRENCY", 8),
    };
  }

  // ─── SEC ticker ingest ───────────────────────────────────────────────────

  /**
   * URL for the SEC company tickers JSON (default: public SEC endpoint).
   * Override via SEC_TICKERS_URL if needed (e.g. for testing or caching proxy).
   */
  secTickersIngestUrl(): string {
    return (
      this.config.get<string>("SEC_TICKERS_URL")?.trim() ||
      "https://www.sec.gov/files/company_tickers.json"
    ).trim();
  }

  /**
   * User-Agent header for SEC requests.
   * SEC policy requires a descriptive User-Agent with a contact email.
   * Override via SEC_TICKERS_USER_AGENT.
   */
  secTickersUserAgent(): string {
    return (
      this.config.get<string>("SEC_TICKERS_USER_AGENT")?.trim() ||
      "MenOfHunger/1.0 (contact@menofhunger.com)"
    ).trim();
  }

  // Optional: typed access to full validated env object if needed later.
  envSnapshot(): Partial<Env> {
    return {
      NODE_ENV: this.config.get<string>("NODE_ENV") as Env["NODE_ENV"],
      PORT: this.config.get<string>("PORT") as Env["PORT"],
      DATABASE_URL: this.config.get<string>(
        "DATABASE_URL",
      ) as Env["DATABASE_URL"],
      ALLOWED_ORIGINS: this.config.get<string>(
        "ALLOWED_ORIGINS",
      ) as Env["ALLOWED_ORIGINS"],
      COOKIE_DOMAIN: this.config.get<string>(
        "COOKIE_DOMAIN",
      ) as Env["COOKIE_DOMAIN"],
      DISABLE_TWILIO_IN_DEV: this.config.get<string>(
        "DISABLE_TWILIO_IN_DEV",
      ) as Env["DISABLE_TWILIO_IN_DEV"],
      TWILIO_ACCOUNT_SID: this.config.get<string>(
        "TWILIO_ACCOUNT_SID",
      ) as Env["TWILIO_ACCOUNT_SID"],
      TWILIO_AUTH_TOKEN: this.config.get<string>(
        "TWILIO_AUTH_TOKEN",
      ) as Env["TWILIO_AUTH_TOKEN"],
      TWILIO_VERIFY_SERVICE_SID: this.config.get<string>(
        "TWILIO_VERIFY_SERVICE_SID",
      ) as Env["TWILIO_VERIFY_SERVICE_SID"],
      R2_ACCOUNT_ID: this.config.get<string>(
        "R2_ACCOUNT_ID",
      ) as Env["R2_ACCOUNT_ID"],
      R2_ACCESS_KEY_ID: this.config.get<string>(
        "R2_ACCESS_KEY_ID",
      ) as Env["R2_ACCESS_KEY_ID"],
      R2_SECRET_ACCESS_KEY: this.config.get<string>(
        "R2_SECRET_ACCESS_KEY",
      ) as Env["R2_SECRET_ACCESS_KEY"],
      R2_BUCKET: this.config.get<string>("R2_BUCKET") as Env["R2_BUCKET"],
      R2_PUBLIC_BASE_URL: this.config.get<string>(
        "R2_PUBLIC_BASE_URL",
      ) as Env["R2_PUBLIC_BASE_URL"],
      GIPHY_API_KEY: this.config.get<string>(
        "GIPHY_API_KEY",
      ) as Env["GIPHY_API_KEY"],
      RATE_LIMIT_TTL_SECONDS: this.config.get<string>(
        "RATE_LIMIT_TTL_SECONDS",
      ) as Env["RATE_LIMIT_TTL_SECONDS"],
      RATE_LIMIT_LIMIT: this.config.get<string>(
        "RATE_LIMIT_LIMIT",
      ) as Env["RATE_LIMIT_LIMIT"],
      RATE_LIMIT_AUTH_START_TTL_SECONDS: this.config.get<string>(
        "RATE_LIMIT_AUTH_START_TTL_SECONDS",
      ) as Env["RATE_LIMIT_AUTH_START_TTL_SECONDS"],
      RATE_LIMIT_AUTH_START_LIMIT: this.config.get<string>(
        "RATE_LIMIT_AUTH_START_LIMIT",
      ) as Env["RATE_LIMIT_AUTH_START_LIMIT"],
      RATE_LIMIT_AUTH_VERIFY_TTL_SECONDS: this.config.get<string>(
        "RATE_LIMIT_AUTH_VERIFY_TTL_SECONDS",
      ) as Env["RATE_LIMIT_AUTH_VERIFY_TTL_SECONDS"],
      RATE_LIMIT_AUTH_VERIFY_LIMIT: this.config.get<string>(
        "RATE_LIMIT_AUTH_VERIFY_LIMIT",
      ) as Env["RATE_LIMIT_AUTH_VERIFY_LIMIT"],
      RATE_LIMIT_POST_CREATE_TTL_SECONDS: this.config.get<string>(
        "RATE_LIMIT_POST_CREATE_TTL_SECONDS",
      ) as Env["RATE_LIMIT_POST_CREATE_TTL_SECONDS"],
      RATE_LIMIT_POST_CREATE_LIMIT: this.config.get<string>(
        "RATE_LIMIT_POST_CREATE_LIMIT",
      ) as Env["RATE_LIMIT_POST_CREATE_LIMIT"],
      RATE_LIMIT_INTERACT_TTL_SECONDS: this.config.get<string>(
        "RATE_LIMIT_INTERACT_TTL_SECONDS",
      ) as Env["RATE_LIMIT_INTERACT_TTL_SECONDS"],
      RATE_LIMIT_INTERACT_LIMIT: this.config.get<string>(
        "RATE_LIMIT_INTERACT_LIMIT",
      ) as Env["RATE_LIMIT_INTERACT_LIMIT"],
      RATE_LIMIT_UPLOAD_TTL_SECONDS: this.config.get<string>(
        "RATE_LIMIT_UPLOAD_TTL_SECONDS",
      ) as Env["RATE_LIMIT_UPLOAD_TTL_SECONDS"],
      RATE_LIMIT_UPLOAD_LIMIT: this.config.get<string>(
        "RATE_LIMIT_UPLOAD_LIMIT",
      ) as Env["RATE_LIMIT_UPLOAD_LIMIT"],
      TRUST_PROXY: this.config.get<string>("TRUST_PROXY") as Env["TRUST_PROXY"],
      BODY_JSON_LIMIT: this.config.get<string>(
        "BODY_JSON_LIMIT",
      ) as Env["BODY_JSON_LIMIT"],
      BODY_URLENCODED_LIMIT: this.config.get<string>(
        "BODY_URLENCODED_LIMIT",
      ) as Env["BODY_URLENCODED_LIMIT"],
      REQUIRE_CSRF_ORIGIN_IN_PROD: this.config.get<string>(
        "REQUIRE_CSRF_ORIGIN_IN_PROD",
      ) as Env["REQUIRE_CSRF_ORIGIN_IN_PROD"],
      STRIPE_SECRET_KEY: this.config.get<string>(
        "STRIPE_SECRET_KEY",
      ) as Env["STRIPE_SECRET_KEY"],
      STRIPE_WEBHOOK_SECRET: this.config.get<string>(
        "STRIPE_WEBHOOK_SECRET",
      ) as Env["STRIPE_WEBHOOK_SECRET"],
      STRIPE_PRICE_PREMIUM_MONTHLY: this.config.get<string>(
        "STRIPE_PRICE_PREMIUM_MONTHLY",
      ) as Env["STRIPE_PRICE_PREMIUM_MONTHLY"],
      STRIPE_PRICE_PREMIUM_PLUS_MONTHLY: this.config.get<string>(
        "STRIPE_PRICE_PREMIUM_PLUS_MONTHLY",
      ) as Env["STRIPE_PRICE_PREMIUM_PLUS_MONTHLY"],
      RESEND_API_KEY: this.config.get<string>(
        "RESEND_API_KEY",
      ) as Env["RESEND_API_KEY"],
      RESEND_FROM_EMAIL: this.config.get<string>(
        "RESEND_FROM_EMAIL",
      ) as Env["RESEND_FROM_EMAIL"],
      RESEND_FROM_NOTIFICATIONS_EMAIL: this.config.get<string>(
        "RESEND_FROM_NOTIFICATIONS_EMAIL",
      ) as Env["RESEND_FROM_NOTIFICATIONS_EMAIL"],
      RESEND_FROM_SUPPORT_EMAIL: this.config.get<string>(
        "RESEND_FROM_SUPPORT_EMAIL",
      ) as Env["RESEND_FROM_SUPPORT_EMAIL"],
      RESEND_FROM_NEWSLETTER_EMAIL: this.config.get<string>(
        "RESEND_FROM_NEWSLETTER_EMAIL",
      ) as Env["RESEND_FROM_NEWSLETTER_EMAIL"],
    };
  }
}