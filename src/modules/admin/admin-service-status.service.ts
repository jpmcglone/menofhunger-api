import { Injectable } from "@nestjs/common";
import OpenAI from "openai";
import { AppConfigService } from "../app/app-config.service";
import { PrismaService } from "../prisma/prisma.service";
import { RedisService } from "../redis/redis.service";
import { TypeSafeService } from "../typesafe/typesafe.service";
import type {
  AdminServiceFeatureDto,
  AdminServiceLevel,
  AdminServiceState,
  AdminServiceStatusDto,
  AdminServiceStatusItemDto,
} from "../../common/dto/admin-service-status.dto";

const PROBE_TIMEOUT_MS = 3_000;
const CACHE_MS = 30_000;
/** Forced refreshes are rate limited so the page cannot be used to hammer providers. */
const MIN_REFRESH_MS = 5_000;

type Probe = { ok: boolean; latencyMs: number; error?: string };

/** What a service needs and how bad it is when it is missing or failing. */
type ServiceSpec = {
  id: string;
  name: string;
  group: string;
  /** Environment variables that must all be set. */
  keys: string[];
  /** Shown as "Optional" in the summary when unset; feature still works without it. */
  optionalKeys?: string[];
  impact: string;
  /** Level when nothing is configured. Production only; development downgrades red to yellow. */
  missingLevel: AdminServiceLevel;
  /** Level when configured but a live check or recent calls fail. */
  failureLevel: AdminServiceLevel;
  probe?: () => Promise<Probe | null>;
  features?: () => AdminServiceFeatureDto[];
  /** Replaces the default failure detail with recent-call health from inside this process. */
  extra?: () => { failing: boolean; detail: string | null } | null;
  /** Marks a deliberate switch-off so it is not reported as a fault. */
  disabled?: () => string | null;
};

/**
 * Builds the admin "Service status" report: for each external dependency, whether its settings
 * are present, whether it answers (for the services that have a cheap, content-free check), and
 * how serious it is if not. Secret values are never read into the report, only variable names.
 */
@Injectable()
export class AdminServiceStatusService {
  private cached: { at: number; report: AdminServiceStatusDto } | null = null;
  private inflight: Promise<AdminServiceStatusDto> | null = null;
  private openai: { key: string; client: OpenAI } | null = null;

  constructor(
    private readonly appConfig: AppConfigService,
    private readonly prisma: PrismaService,
    private readonly redis: RedisService,
    private readonly typeSafe: TypeSafeService,
  ) {}

  async report(opts: { refresh?: boolean } = {}): Promise<AdminServiceStatusDto> {
    const age = this.cached ? Date.now() - this.cached.at : Infinity;
    if (this.cached && (opts.refresh ? age < MIN_REFRESH_MS : age < CACHE_MS)) return this.cached.report;
    if (this.inflight) return this.inflight;
    this.inflight = this.build()
      .then((report) => {
        this.cached = { at: Date.now(), report };
        return report;
      })
      .finally(() => {
        this.inflight = null;
      });
    return this.inflight;
  }

  private async build(): Promise<AdminServiceStatusDto> {
    const specs = this.specs();
    const services = await Promise.all(specs.map((spec) => this.evaluate(spec)));
    const counts = { green: 0, yellow: 0, red: 0 };
    for (const s of services) counts[s.level] += 1;
    return {
      asOf: new Date().toISOString(),
      environment: this.appConfig.nodeEnv(),
      overall: counts.red ? "red" : counts.yellow ? "yellow" : "green",
      counts,
      services,
    };
  }

  private async evaluate(spec: ServiceSpec): Promise<AdminServiceStatusItemDto> {
    const base = {
      id: spec.id,
      name: spec.name,
      group: spec.group,
      impact: spec.impact,
      features: spec.features?.() ?? [],
    };
    const missingKeys = spec.keys.filter((key) => !this.appConfig.envIsSet(key));
    const optionalMissing = (spec.optionalKeys ?? []).filter((key) => !this.appConfig.envIsSet(key));
    const anySet = missingKeys.length < spec.keys.length;
    // Missing settings in development are expected, so they should not look like an outage.
    const missingLevel: AdminServiceLevel =
      spec.missingLevel === "red" && !this.appConfig.isProd() ? "yellow" : spec.missingLevel;

    const off = spec.disabled?.() ?? null;
    if (off) {
      return { ...base, level: "yellow", state: "disabled", summary: off, detail: null, missingKeys: [], checkedLive: false, latencyMs: null };
    }
    if (spec.keys.length && !anySet) {
      return {
        ...base, level: missingLevel, state: "not_configured",
        summary: this.appConfig.isProd() ? "Not configured" : "Not configured (development)",
        detail: null, missingKeys, checkedLive: false, latencyMs: null,
      };
    }
    if (missingKeys.length) {
      return {
        ...base, level: spec.failureLevel === "red" || missingLevel === "red" ? "red" : "yellow", state: "partial",
        summary: `Partly configured: ${missingKeys.length} setting${missingKeys.length === 1 ? "" : "s"} missing`,
        detail: null, missingKeys, checkedLive: false, latencyMs: null,
      };
    }

    const probe = spec.probe ? await spec.probe().catch((err) => ({ ok: false, latencyMs: 0, error: messageOf(err) })) : null;
    const extra = spec.extra?.() ?? null;
    if (probe && !probe.ok) {
      return {
        ...base, level: spec.failureLevel, state: "failing", summary: "Settings present but not connecting",
        detail: probe.error ?? null, missingKeys: [], checkedLive: true, latencyMs: probe.latencyMs,
      };
    }
    if (extra?.failing) {
      return {
        ...base, level: spec.failureLevel, state: "failing", summary: "Reachable, but recent requests are failing",
        detail: extra.detail, missingKeys: [], checkedLive: Boolean(probe), latencyMs: probe?.latencyMs ?? null,
      };
    }

    const state: AdminServiceState = probe ? "connected" : "configured";
    const optionalNote = optionalMissing.length ? ` Optional settings not set: ${optionalMissing.join(", ")}.` : "";
    return {
      ...base, level: "green", state,
      summary: probe ? "Connected" : "Configured (no live check available)",
      detail: optionalNote.trim() || null, missingKeys: [], checkedLive: Boolean(probe), latencyMs: probe?.latencyMs ?? null,
    };
  }

  private specs(): ServiceSpec[] {
    const typeSafeCfg = () => this.appConfig.typeSafe();
    return [
      {
        id: "database", name: "Postgres database", group: "Core", keys: ["DATABASE_URL"], missingLevel: "red", failureLevel: "red",
        impact: "The whole product is down.",
        probe: () => timed(async () => { await this.prisma.$queryRaw`SELECT 1`; }),
      },
      {
        id: "redis", name: "Redis", group: "Core", keys: [], missingLevel: "red", failureLevel: "red",
        impact: "Caching, queues, rate limits, and realtime fan-out stop working.",
        probe: () => timed(async () => { await this.redis.raw().ping(); }),
      },
      {
        id: "auth-secrets", name: "Session and OTP secrets", group: "Core", keys: ["SESSION_HMAC_SECRET", "OTP_HMAC_SECRET"],
        missingLevel: "red", failureLevel: "red", impact: "Members cannot sign in securely.",
      },
      {
        id: "twilio", name: "Twilio Verify (SMS sign-in)", group: "Sign-in and messaging",
        keys: ["TWILIO_ACCOUNT_SID", "TWILIO_AUTH_TOKEN", "TWILIO_VERIFY_SERVICE_SID"], missingLevel: "red", failureLevel: "red",
        impact: "Members cannot receive sign-in codes.",
        disabled: () => (this.appConfig.disableTwilioInDev() && !this.appConfig.isProd() ? "Disabled for development" : null),
      },
      {
        id: "resend", name: "Resend (email)", group: "Sign-in and messaging", keys: ["RESEND_API_KEY", "RESEND_FROM_EMAIL"],
        optionalKeys: ["RESEND_FROM_NOTIFICATIONS_EMAIL", "RESEND_FROM_SUPPORT_EMAIL", "RESEND_FROM_NEWSLETTER_EMAIL"],
        missingLevel: "yellow", failureLevel: "red", impact: "Verification, notification, digest, and newsletter emails are not sent.",
      },
      {
        id: "web-push", name: "Web push (VAPID)", group: "Sign-in and messaging", keys: ["VAPID_PUBLIC_KEY", "VAPID_PRIVATE_KEY"],
        missingLevel: "yellow", failureLevel: "yellow", impact: "Browser push notifications are not delivered.",
      },
      {
        id: "apns", name: "Apple push (APNs)", group: "Sign-in and messaging",
        keys: ["APNS_KEY_ID", "APNS_TEAM_ID", "APNS_PRIVATE_KEY", "APNS_BUNDLE_ID"], missingLevel: "yellow", failureLevel: "yellow",
        impact: "iOS push notifications are not delivered.",
      },
      {
        id: "r2", name: "Cloudflare R2 (media storage)", group: "Storage and media",
        keys: ["R2_ACCOUNT_ID", "R2_ACCESS_KEY_ID", "R2_SECRET_ACCESS_KEY", "R2_BUCKET"], optionalKeys: ["R2_PUBLIC_BASE_URL"],
        missingLevel: "red", failureLevel: "red", impact: "Uploads fail and public media URLs are empty.",
        probe: async () => {
          const base = this.appConfig.r2()?.publicBaseUrl;
          return base ? timed(async () => { await fetch(base, { method: "HEAD", signal: AbortSignal.timeout(PROBE_TIMEOUT_MS) }); }) : null;
        },
      },
      {
        id: "sfu", name: "Cloudflare Calls (SFU)", group: "Storage and media", keys: ["CLOUDFLARE_SFU_APP_ID", "CLOUDFLARE_SFU_APP_SECRET"],
        missingLevel: "yellow", failureLevel: "yellow", impact: "Voice and video calls cannot be admitted.",
        features: () => [{ label: "Call admission switch", enabled: this.appConfig.callsSfuEnabled() }],
      },
      {
        id: "giphy", name: "Giphy", group: "Storage and media", keys: ["GIPHY_API_KEY"], missingLevel: "yellow", failureLevel: "yellow",
        impact: "GIF search in the composer is unavailable.",
      },
      {
        id: "stripe", name: "Stripe (membership billing)", group: "Payments",
        keys: ["STRIPE_SECRET_KEY", "STRIPE_WEBHOOK_SECRET", "STRIPE_PRICE_PREMIUM_MONTHLY", "STRIPE_PRICE_PREMIUM_PLUS_MONTHLY"],
        missingLevel: "red", failureLevel: "red", impact: "Web checkout and subscription updates stop.",
      },
      {
        id: "apple-iap", name: "Apple in-app purchases", group: "Payments",
        keys: ["APPLE_IAP_BUNDLE_ID", "APPLE_IAP_ISSUER_ID", "APPLE_IAP_KEY_ID", "APPLE_IAP_PRIVATE_KEY"], missingLevel: "yellow", failureLevel: "yellow",
        impact: "iOS purchases and renewals cannot be verified.",
        features: () => [{ label: `Apple environment: ${this.appConfig.appleIap()?.environment ?? "unset"}`, enabled: Boolean(this.appConfig.appleIap()) }],
      },
      {
        id: "openai", name: "OpenAI (Marv replies and briefs)", group: "AI", keys: ["OPENAI_API_KEY"], missingLevel: "yellow", failureLevel: "red",
        impact: "Marv sends a canned reply instead of an answer. Admin briefs and topic labels are skipped.",
        probe: () => this.probeOpenAI(),
        features: () => [{ label: "Marv enabled", enabled: this.appConfig.marvBot().enabled }],
        disabled: () => (this.appConfig.marvBot().enabled ? null : "Marv is switched off (MARV_ENABLED=false)"),
      },
      {
        id: "typesafe", name: "TypeSafe AI (Jev)", group: "AI", keys: ["TYPESAFE_API_KEY"], missingLevel: "yellow", failureLevel: "yellow",
        impact: "Marv routing falls back to keyword rules, every public mention gets a reply, and moderation runs go without classifier hints. Nothing breaks.",
        probe: async () => {
          const result = await this.typeSafe.probe(PROBE_TIMEOUT_MS);
          return result ? { ok: result.ok, latencyMs: result.latencyMs, error: result.ok ? undefined : result.error } : null;
        },
        features: () => [
          { label: "Marv routing", enabled: typeSafeCfg().routingEnabled },
          { label: "Reply gate", enabled: typeSafeCfg().replyGateEnabled },
          { label: "Untagged replies to Marv", enabled: typeSafeCfg().addressingEnabled },
          { label: "Moderation triage hints", enabled: typeSafeCfg().triageEnabled },
          { label: `Model: ${typeSafeCfg().model}`, enabled: true },
        ],
        extra: () => {
          const health = this.typeSafe.healthSnapshot();
          if (health.budgetExhausted) return { failing: true, detail: `Daily budget of $${health.dailyBudgetUsd} reached ($${health.spentTodayUsd.toFixed(2)} spent); Jev is paused until tomorrow (UTC).` };
          return health.consecutiveFailures >= 3 ? { failing: true, detail: health.lastFailure } : null;
        },
      },
      {
        id: "posthog", name: "PostHog", group: "Observability", keys: ["POSTHOG_API_KEY"], optionalKeys: ["POSTHOG_FEATURE_FLAGS_KEY"],
        missingLevel: "yellow", failureLevel: "yellow", impact: "Product analytics are not recorded; feature flags evaluate remotely or not at all.",
      },
      {
        id: "sentry", name: "Sentry", group: "Observability", keys: ["SENTRY_DSN"], missingLevel: "yellow", failureLevel: "yellow",
        impact: "Server errors are not reported.",
      },
      {
        id: "slack", name: "Slack webhook", group: "Observability", keys: ["SLACK_WEBHOOK_URL"], missingLevel: "yellow", failureLevel: "yellow",
        impact: "Operational alerts are not posted to Slack.",
      },
      {
        id: "x", name: "X (Twitter) integration", group: "Integrations", keys: ["X_CLIENT_ID", "X_CLIENT_SECRET", "X_TOKEN_ENCRYPTION_KEY"],
        missingLevel: "yellow", failureLevel: "yellow", impact: "Cross-posting and X previews are unavailable.",
      },
      {
        id: "pickax", name: "Pickax", group: "Integrations", keys: ["PICKAX_SECRET_ENCRYPTION_KEY"], optionalKeys: ["PICKAX_OAUTH_CLIENT_ID", "PICKAX_OAUTH_CLIENT_SECRET"],
        missingLevel: "yellow", failureLevel: "yellow", impact: "Pickax connections cannot be stored or used.",
      },
      {
        id: "strava", name: "Strava", group: "Integrations", keys: ["STRAVA_CLIENT_ID", "STRAVA_CLIENT_SECRET"], missingLevel: "yellow", failureLevel: "yellow",
        impact: "Fitness connections and activity sync are unavailable.",
      },
    ];
  }

  private async probeOpenAI(): Promise<Probe | null> {
    const key = this.appConfig.marvOpenAI().apiKey;
    if (!key) return null;
    if (!this.openai || this.openai.key !== key) this.openai = { key, client: new OpenAI({ apiKey: key }) };
    const client = this.openai.client;
    return timed(async () => {
      await client.models.list({ timeout: PROBE_TIMEOUT_MS, maxRetries: 0 });
    });
  }
}

async function timed(run: () => Promise<void>): Promise<Probe> {
  const startedAt = Date.now();
  try {
    await Promise.race([
      run(),
      new Promise<never>((_, reject) => setTimeout(() => reject(new Error("Timed out")), PROBE_TIMEOUT_MS + 500).unref()),
    ]);
    return { ok: true, latencyMs: Date.now() - startedAt };
  } catch (err) {
    return { ok: false, latencyMs: Date.now() - startedAt, error: messageOf(err).slice(0, 300) };
  }
}

function messageOf(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
