import { Injectable } from '@nestjs/common';
import { AsyncLocalStorage } from 'async_hooks';

/**
 * Request-scoped memoization with zero staleness risk.
 *
 * - One cache Map per HTTP request (initialized in main.ts middleware).
 * - Safe no-op behavior when no request context exists (e.g. cron jobs).
 */
@Injectable()
export class RequestCacheService {
  private readonly als = new AsyncLocalStorage<Map<string, unknown>>();

  runWithNewStore<T>(fn: () => T): T {
    return this.als.run(new Map<string, unknown>(), fn);
  }

  private store(): Map<string, unknown> | null {
    return this.als.getStore() ?? null;
  }

  get<T>(key: string): T | undefined {
    return this.store()?.get(key) as T | undefined;
  }

  set(key: string, value: unknown): void {
    this.store()?.set(key, value);
  }
}

