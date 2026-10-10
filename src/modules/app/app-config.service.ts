import { Injectable } from "@nestjs/common";
import { AppConfigValues } from "./app-config.values";
import { ConfigService } from "@nestjs/config";

export type { NodeEnv, TwilioVerifyConfig, R2Config, StravaConfig, XConfig, StripeConfig, AppleIapConfig, EmailConfig, MarvBotConfig, MarvOpenAIConfig, TypeSafeConfig, MarvCreditConfig, MarvLimitsConfig } from "./app-config.types";

@Injectable()
export class AppConfigService extends AppConfigValues {
  /** FCM service-account credentials remain server-side; never expose them to clients. */
  fcm(): { projectId: string; clientEmail: string; privateKey: string } | null {
    const projectId = this.config.get<string>("FCM_PROJECT_ID")?.trim() ?? "";
    const clientEmail =
      this.config.get<string>("FCM_CLIENT_EMAIL")?.trim() ?? "";
    const privateKey = (this.config.get<string>("FCM_PRIVATE_KEY") ?? "")
      .replace(/\\n/g, "\n")
      .trim();
    return projectId && clientEmail && privateKey
      ? { projectId, clientEmail, privateKey }
      : null;
  }

  emailWebhookSecret(): string | null {
    return this.config.get<string>('RESEND_WEBHOOK_SECRET')?.trim() || null;
  }

  emailPublicApiUrl(): string {
    return (this.config.get<string>('EMAIL_PUBLIC_API_URL')?.trim() || (this.isProd() ? 'https://api.menofhunger.com/v1' : 'http://localhost:3001/v1')).replace(/\/$/, '');
  }

  /** Set false when Stripe/Apple-managed payment notices already cover the same member. */
  emailBillingNoticesEnabled(): boolean {
    return !['false', '0', 'off', 'no'].includes(String(this.config.get<string | boolean>('EMAIL_BILLING_NOTICES_ENABLED') ?? 'true').trim().toLowerCase());
  }

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
