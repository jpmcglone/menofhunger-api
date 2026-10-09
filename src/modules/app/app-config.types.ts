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
