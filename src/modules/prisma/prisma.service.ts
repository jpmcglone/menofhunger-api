import { Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { PrismaClient } from '@prisma/client';
import * as crypto from 'node:crypto';
import { AppConfigService } from '../app/app-config.service';

@Injectable()
export class PrismaService extends PrismaClient implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(PrismaService.name);

  constructor(private readonly appConfig: AppConfigService) {
    // NOTE: must not access `this` before `super()` in derived constructors.
    const enabled = appConfig.prismaLogSlowQueries();
    super(
      enabled
        ? {
            // Use Prisma query events for timing (Prisma v6+; avoids middleware APIs).
            log: [{ emit: 'event', level: 'query' }],
          }
        : undefined,
    );

    if (enabled) {
      const slowMs = appConfig.prismaSlowQueryMs();
      // Prisma's `$on` typing varies across versions; use a narrow `any` cast.
      (this as any).$on('query', (e: any) => {
        const ms = typeof e?.duration === 'number' ? e.duration : NaN;
        if (!Number.isFinite(ms) || ms < slowMs) return;

        // Do NOT log query params to avoid leaking PII. Use a short fingerprint for grouping.
        const q = String(e?.query ?? '');
        const kind = q.trim().split(/\s+/, 1)[0]?.toUpperCase() || 'QUERY';
        const fp = crypto.createHash('sha1').update(q).digest('hex').slice(0, 10);
        this.logger.warn(`[prisma] slow ${Math.floor(ms)}ms kind=${kind} query=${fp}`);
      });
    }
  }

  async onModuleInit() {
    const retries = this.appConfig.prismaConnectRetries();
    const delayMs = this.appConfig.prismaConnectRetryDelayMs();

    let lastError: unknown;
    for (let attempt = 1; attempt <= retries; attempt++) {
      try {
        await this.$connect();
        return;
      } catch (err) {
        lastError = err;
        // Give Postgres a moment to come up (especially when using docker compose).
        await new Promise((r) => setTimeout(r, delayMs));
      }
    }

    throw new Error(
      `Prisma could not connect to the database after ${retries} attempts. ` +
        `Is Postgres running and is DATABASE_URL correct?\n` +
        `Last error: ${String((lastError as Error)?.message ?? lastError)}`,
    );
  }

  async onModuleDestroy() {
    await this.$disconnect();
  }
}

