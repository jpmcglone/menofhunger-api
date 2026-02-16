import { Injectable, Logger, OnModuleDestroy } from '@nestjs/common';
import Redis from 'ioredis';
import { AppConfigService } from '../app/app-config.service';

@Injectable()
export class RedisService implements OnModuleDestroy {
  private readonly logger = new Logger(RedisService.name);
  private readonly client: Redis;

  constructor(cfg: AppConfigService) {
    // Create a dedicated Redis connection for app caching.
    // BullMQ uses its own connections internally; sharing is possible but not required.
    this.client = new Redis(cfg.redisUrl(), {
      // Prefer failing fast on long outages rather than hanging requests indefinitely.
      maxRetriesPerRequest: 2,
      enableReadyCheck: true,
      // Keep default reconnect behavior.
    });

    this.client.on('error', (err) => {
      // Avoid noisy logs; ioredis can emit frequent transient errors during reconnects.
      this.logger.warn(`Redis error: ${err?.message ?? String(err)}`);
    });
  }

  raw(): Redis {
    return this.client;
  }

  async onModuleDestroy() {
    try {
      await this.client.quit();
    } catch {
      this.client.disconnect();
    }
  }
}

