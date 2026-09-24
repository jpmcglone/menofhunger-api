import { Injectable, Logger, OnModuleDestroy } from '@nestjs/common';
import { PostHog } from 'posthog-node';
import { AppConfigService } from '../../modules/app/app-config.service';

type FlagPersonProperties = Record<string, string>;

@Injectable()
export class PosthogService implements OnModuleDestroy {
  private readonly logger = new Logger(PosthogService.name);
  private client: PostHog | null = null;

  constructor(private readonly appConfig: AppConfigService) {
    const key = this.appConfig.posthogApiKey();
    const host = this.appConfig.posthogHost();

    // A real PostHog project key starts with "phc_" and is ~48 chars.
    // Reject placeholders so we never fire real network requests when not set up.
    const isValidKey = key && key.startsWith('phc_') && key.length >= 20;
    if (isValidKey) {
      const personalApiKey = this.appConfig.posthogFeatureFlagsKey() ?? undefined;
      this.client = new PostHog(key, {
        host,
        // Batch events and flush on shutdown to avoid blocking request handlers.
        flushAt: 20,
        flushInterval: 10_000,
        // With a feature-flags secure key, flags evaluate in-process from polled definitions;
        // otherwise each evaluation is a remote call bounded by this timeout.
        personalApiKey,
        featureFlagsPollingInterval: 60_000,
        featureFlagsRequestTimeoutMs: 1_500,
      });
      this.logger.log(`PostHog initialized (host=${host}, flags=${personalApiKey ? 'local' : 'remote'})`);
    } else {
      this.logger.log('PostHog not configured — event capture disabled. Set POSTHOG_API_KEY when ready.');
    }
  }

  capture(distinctId: string, event: string, properties?: Record<string, unknown>): void {
    if (!this.client) return;
    try {
      this.client.capture({ distinctId, event, properties: { ...this.safeProperties(properties), platform: 'api', environment: this.appConfig.isProd() ? 'production' : 'development' } });
    } catch (err) {
      this.logger.warn(`PostHog capture failed for event=${event}: ${(err as Error)?.message}`);
    }
  }

  /** Product analytics never needs private text or authentication/contact data. */
  private safeProperties(properties: Record<string, unknown> = {}): Record<string, unknown> {
    return Object.fromEntries(Object.entries(properties).filter(([key]) =>
      !['query', 'search_query', 'phone', 'phone_masked', 'email', 'body', 'message', 'token'].includes(key),
    ));
  }

  /**
   * Evaluates a boolean flag for a member. Returns `fallback` when PostHog is unconfigured,
   * unreachable, or the flag does not exist, so a flag outage never changes behavior.
   */
  async isFeatureEnabled(
    key: string,
    distinctId: string,
    options: { fallback?: boolean; personProperties?: FlagPersonProperties } = {},
  ): Promise<boolean> {
    const fallback = options.fallback ?? false;
    if (!this.client) return fallback;
    try {
      const enabled = await this.client.isFeatureEnabled(key, distinctId, {
        personProperties: options.personProperties,
      });
      return enabled ?? fallback;
    } catch (err) {
      this.logger.warn(`PostHog flag evaluation failed for flag=${key}: ${(err as Error)?.message}`);
      return fallback;
    }
  }

  /** Returns the multivariate variant key, `true`/`false` for boolean flags, or null when unknown. */
  async getFeatureFlag(
    key: string,
    distinctId: string,
    options: { personProperties?: FlagPersonProperties } = {},
  ): Promise<string | boolean | null> {
    if (!this.client) return null;
    try {
      const value = await this.client.getFeatureFlag(key, distinctId, {
        personProperties: options.personProperties,
      });
      return value ?? null;
    } catch (err) {
      this.logger.warn(`PostHog flag evaluation failed for flag=${key}: ${(err as Error)?.message}`);
      return null;
    }
  }

  async onModuleDestroy() {
    if (this.client) {
      await this.client.shutdown();
    }
  }
}
