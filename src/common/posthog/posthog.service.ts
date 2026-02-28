import { Injectable, Logger, OnModuleDestroy } from '@nestjs/common';
import { PostHog } from 'posthog-node';
import { AppConfigService } from '../../modules/app/app-config.service';

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
      this.client = new PostHog(key, {
        host,
        // Batch events and flush on shutdown to avoid blocking request handlers.
        flushAt: 20,
        flushInterval: 10_000,
      });
      this.logger.log(`PostHog initialized (host=${host})`);
    } else {
      this.logger.log('PostHog not configured — event capture disabled. Set POSTHOG_API_KEY when ready.');
    }
  }

  capture(distinctId: string, event: string, properties?: Record<string, unknown>): void {
    if (!this.client) return;
    try {
      this.client.capture({ distinctId, event, properties: properties ?? {} });
    } catch (err) {
      this.logger.warn(`PostHog capture failed for event=${event}: ${(err as Error)?.message}`);
    }
  }

  async onModuleDestroy() {
    if (this.client) {
      await this.client.shutdown();
    }
  }
}
