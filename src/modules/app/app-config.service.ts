import { Injectable } from "@nestjs/common";
import { AppConfigValues } from "./app-config.values";
import { ConfigService } from "@nestjs/config";

export type NodeEnv = "development" | "test" | "production";

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

export type StravaConfig = {
  clientId: string;
  clientSecret: string;
  webhookVerifyToken: string;
};

export type XConfig = {
  clientId: string;
  clientSecret: string;
  encryptionKey: string;
  /** Per-member monthly cross-post budget, in cents. */
  monthlyBudgetCents: number;
};

export type StripeConfig = {
  secretKey: string;
  webhookSecret: string;
  pricePremiumMonthly: string;
  pricePremiumPlusMonthly: string;
  /** Canonical frontend base URL used for redirect URLs (checkout/portal) and webhook click-through. */
  frontendBaseUrl: string;
};

export type AppleIapConfig = {
  bundleId: string;
  issuerId: string;
  keyId: string;
  /** PEM-formatted .p8 private key (literal "\n" already expanded). */
  privateKey: string;
  /** Maps App Store productId → internal tier ('premium' | 'premiumPlus'). */
  productTierMap: Record<string, "premium" | "premiumPlus">;
  /** Which App Store environment to verify signed data against. */
  environment: "sandbox" | "production";
  /** Numeric App Store app ID. Required by Apple's verifier in production; null in sandbox. */
  appAppleId: number | null;
};

export type EmailConfig = {
  provider: "resend";
  apiKey: string;
  fromEmail: {
    default: string;
    notifications: string;
    support: string;
    newsletter: string;
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
  fastModel: string;
  regularModel: string;
  smartModel: string;
  /** When true, hosted `web_search` is added to Marv requests for qualifying modes. */
  webSearchEnabled: boolean;
  /** Modes (subset of 'fast' | 'regular' | 'smart') that may use web search. */
  webSearchModes: string[];
  /** max_output_tokens override when web search is active — must be larger than the base limit. */
  webSearchMaxOutputTokens: number;
  /** When true, image inputs (input_image parts) are sent to OpenAI for qualifying modes. */
  visionEnabled: boolean;
  /** Modes that may receive image inputs. Default regular,smart. */
  visionModes: string[];
  /** Max images per turn (caps both selection logic and input_image parts). Default 16. */
  visionMaxImagesPerTurn: number;
  /** Admin-only long jobs (intro brief). Not a Marv chat tier. */
  astraModel: string;
};

export type TypeSafeConfig = {
  apiKey: string;
  /** Alias such as `jev-latest`, or a pinned version such as `jev-1.13.0`. */
  model: string;
  timeoutMs: number;
  /** Dollars one API process may spend on Jev per UTC day before calls stop and callers use their fallbacks. 0 = unlimited. */
  dailyBudgetUsd: number;
  /** Price used to turn tokens into dollars. Defaults to the higher published rate so the cap errs safe. */
  inputUsdPerMillionTokens: number;
  /** Marv tier, web-search and crisis signals. Rules remain the fallback and the crisis floor. */
  routingEnabled: boolean;
  /** Skip paid Marv replies to public mentions that need no answer (thanks, amen, lol). */
  replyGateEnabled: boolean;
  /** Recognize untagged posts that speak to Marv (a reply to him, or his name without an @). */
  addressingEnabled: boolean;
  /** First-pass category, urgency and escalation hints for admin delegated moderation runs. */
  triageEnabled: boolean;
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
export class AppConfigService extends AppConfigValues {
  xPublishing() {
    const ids = (key: string) =>
      (this.config.get<string>(key) ?? "")
        .split(",")
        .map((s) => s.trim())
        .filter(Boolean);
    return {
      enabled: this.config.get<string>("X_ADVANCED_ENABLED") === "true",
      accountIds: ids("X_ADVANCED_ACCOUNT_IDS"),
      quoteAccountIds: ids("X_QUOTE_ENTERPRISE_ACCOUNT_IDS"),
      longAccountIds: ids("X_LONG_TEXT_ACCOUNT_IDS"),
      editAccountIds: ids("X_EDIT_ACCOUNT_IDS"),
      postMaxMicros: this.config.get<number>("X_ADVANCED_POST_MAX_MICROS"),
      mediaMaxMicros: this.config.get<number>("X_ADVANCED_MEDIA_MAX_MICROS"),
      priceVersion: this.config.get<string>("X_ADVANCED_PRICE_VERSION") ?? "",
    };
  }

  xArticle() {
    return {
      enabled: this.config.get<string>("X_ARTICLE_ENABLED") === "true",
      accountIds: (this.config.get<string>("X_ARTICLE_ACCOUNT_IDS") ?? "")
        .split(",")
        .map((value) => value.trim())
        .filter(Boolean),
      maximumMicros: this.config.get<number>("X_ARTICLE_MAX_MICROS"),
      priceVersion: this.config.get<string>("X_ARTICLE_PRICE_VERSION"),
      bucket:
        this.config.get<"regular" | "expensive">("X_ARTICLE_BUCKET") ??
        "regular",
    };
  }

  xNews() {
    return {
      enabled: this.config.get<string>("X_NEWS_ENABLED") === "true",
      pilotStart: this.config.get<string>("X_NEWS_PILOT_START"),
      accountUserId: this.config.get<string>("X_NEWS_ACCOUNT_USER_ID"),
      query: this.config.get<string>("X_NEWS_QUERY"),
      requestMaxMicros: this.config.get<number>("X_NEWS_REQUEST_MAX_MICROS"),
      priceVersion: this.config.get<string>("X_NEWS_PRICE_VERSION"),
    };
  }

  audioTranscription() {
    return {
      enabled: this.config.get<string>("AUDIO_TRANSCRIPTION_ENABLED") === "true" && Boolean(this.config.get<string>("OPENAI_API_KEY")?.trim()),
      apiKey: this.config.get<string>("OPENAI_API_KEY")?.trim() ?? "",
      model: this.config.get<string>("OPENAI_TRANSCRIBE_MODEL")?.trim() || "gpt-4o-transcribe",
    };
  }

  /** Channel uploads share the main R2 bucket; the protected `channel-uploads/` prefix is only ever served through the authorized API. */
  channelMediaBucket(): string | null {
    return this.r2()?.bucket ?? null;
  }

  groupChannels() {
    return {
      enabled: this.config.get<string>("GROUP_CHANNELS_ENABLED") !== "false",
      groupIds: (this.config.get<string>("GROUP_CHANNELS_GROUP_IDS") ?? "").split(",").map(id => id.trim()).filter(Boolean),
    };
  }

  integrationBudget(
    bucket: "regular" | "expensive" | "reserve" | "acquisition" = "regular",
  ) {
    return {
      enabled: this.config.get<string>("INTEGRATION_BUDGET_ENABLED") === "true",
      companyMonthlyMicros: Number(
        this.config.get("INTEGRATION_COMPANY_MONTHLY_MICROS") ?? 0,
      ),
      companyDailyMicros: Number(
        this.config.get("INTEGRATION_COMPANY_DAILY_MICROS") ?? 0,
      ),
      removalHeadroomMicros: Number(
        this.config.get("INTEGRATION_REMOVAL_HEADROOM_MICROS") ?? 0,
      ),
      providerMonthlyMicros: Number(
        this.config.get("INTEGRATION_X_MONTHLY_MICROS") ?? 0,
      ),
      sharedMonthlyMicros: Number(
        this.config.get(
          bucket === "acquisition"
            ? "INTEGRATION_ACQUISITION_MICROS"
            : "INTEGRATION_FUNDED_RESERVE_MICROS",
        ) ?? 0,
      ),
      priceVersion:
        this.config.get<string>("INTEGRATION_X_PRICE_VERSION") ?? "",
      profileContextEnabled:
        this.config.get<string>("X_PROFILE_CONTEXT_ENABLED") === "true",
      profilePreviewEnabled:
        this.config.get<string>("X_PROFILE_PREVIEW_ENABLED") === "true",
      imageUploadMaxMicros: this.config.get<number>(
        "X_IMAGE_UPLOAD_MAX_MICROS",
      ),
    };
  }

  partner() {
    return {
      enabled: this.config.get<string>("PARTNER_API_ENABLED") === "true",
      webhooks: this.config.get<string>("PARTNER_WEBHOOKS_ENABLED") === "true",
      outboundPaused:
        this.config.get<string>("OUTBOUND_DELIVERY_PAUSED") === "true",
      jwks: this.config.get<string>("PARTNER_OIDC_JWKS") || "",
      encryptionKey: this.config.get<string>("PARTNER_ENCRYPTION_KEY") || "",
      issuer: `${new URL(this.browserHandoffBaseUrl()).origin}/oauth`,
      pickaxPartnerClientId:
        this.config.get<string>("PICKAX_PARTNER_CLIENT_ID") || "",
      pickaxOAuthIssuer: this.config.get<string>("PICKAX_OAUTH_ISSUER") || "",
      pickaxOAuthClientId:
        this.config.get<string>("PICKAX_OAUTH_CLIENT_ID") || "",
      pickaxOAuthClientSecret:
        this.config.get<string>("PICKAX_OAUTH_CLIENT_SECRET") || "",
      pickaxOAuth: this.config.get<string>("PICKAX_OAUTH_ENABLED") === "true",
      pickaxDelete:
        this.config.get<string>("PICKAX_REMOTE_DELETE_ENABLED") === "true",
      xCountAllowance:
        this.config.get<string>("X_COUNT_ALLOWANCE_ENABLED") === "true",
    };
  }

  constructor(config: ConfigService) { super(config); }

}
