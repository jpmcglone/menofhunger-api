import { Injectable, Logger, OnModuleDestroy } from '@nestjs/common';
import Redis from 'ioredis';
import { AppConfigService } from '../app/app-config.service';
import * as crypto from 'node:crypto';

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

  duplicate(overrides?: Partial<ConstructorParameters<typeof Redis>[1]>): Redis {
    // ioredis duplicate() is a shallow clone; safe for pub/sub and separate pipelines.
    // Pass overrides to allow subscriber connections to disable the ready-check
    // (subscriber-mode connections only accept SUBSCRIBE/UNSUBSCRIBE commands, not INFO).
    return this.client.duplicate(overrides ?? {});
  }

  async getString(key: string): Promise<string | null> {
    const k = (key ?? '').trim();
    if (!k) return null;
    const v = await this.client.get(k);
    return v ?? null;
  }

  async setString(
    key: string,
    value: string,
    opts?: { ttlMs?: number; ttlSeconds?: number; onlyIfAbsent?: boolean },
  ): Promise<boolean> {
    const k = (key ?? '').trim();
    if (!k) return false;
    const v = String(value ?? '');
    const ttlMs =
      typeof opts?.ttlMs === 'number' && Number.isFinite(opts.ttlMs) && opts.ttlMs > 0
        ? Math.floor(opts.ttlMs)
        : null;
    const ttlSeconds =
      !ttlMs && typeof opts?.ttlSeconds === 'number' && Number.isFinite(opts.ttlSeconds) && opts.ttlSeconds > 0
        ? Math.floor(opts.ttlSeconds)
        : null;
    const nx = opts?.onlyIfAbsent === true;

    if (ttlMs) {
      const res = await (nx ? this.client.set(k, v, 'PX', ttlMs, 'NX') : this.client.set(k, v, 'PX', ttlMs));
      return res === 'OK';
    }
    if (ttlSeconds) {
      const res = await (nx ? this.client.set(k, v, 'EX', ttlSeconds, 'NX') : this.client.set(k, v, 'EX', ttlSeconds));
      return res === 'OK';
    }
    const res = await (nx ? this.client.set(k, v, 'NX') : this.client.set(k, v));
    return res === 'OK';
  }

  async getJson<T>(key: string): Promise<T | null> {
    const raw = await this.getString(key);
    if (!raw) return null;
    try {
      return JSON.parse(raw) as T;
    } catch {
      // Corrupt cache entry; delete best-effort.
      this.client.del((key ?? '').trim()).catch(() => undefined);
      return null;
    }
  }

  async setJson(key: string, value: unknown, opts?: { ttlMs?: number; ttlSeconds?: number; onlyIfAbsent?: boolean }) {
    return await this.setString(key, JSON.stringify(value), opts);
  }

  async del(...keys: Array<string | null | undefined>): Promise<number> {
    const ks = keys.map((k) => (k ?? '').trim()).filter(Boolean);
    if (ks.length === 0) return 0;
    return await this.client.del(...ks);
  }

  /**
   * Best-effort distributed lock using SET NX PX and a token-based release.
   * Returns null if lock could not be acquired quickly; callers should fall back
   * to a safe non-fetching path (e.g. serve cached/DB-stale) to avoid stampedes.
   */
  async withLock<T>(
    key: string,
    opts: { ttlMs: number; waitMs?: number; retryDelayMs?: number },
    fn: () => Promise<T>,
  ): Promise<T | null> {
    const k = (key ?? '').trim();
    if (!k) return null;
    const ttlMs = Math.max(1, Math.floor(opts.ttlMs));
    const waitMs = Math.max(0, Math.floor(opts.waitMs ?? 0));
    const retryDelayMs = Math.max(5, Math.floor(opts.retryDelayMs ?? 25));

    const token = crypto.randomUUID();
    const deadline = Date.now() + waitMs;
    let attempt = 0;

    while (true) {
      const ok = await this.setString(k, token, { ttlMs, onlyIfAbsent: true });
      if (ok) break;
      if (Date.now() >= deadline) return null;
      // Backoff + jitter to avoid thundering herds under contention.
      // Cap delay so we keep latency bounded for short wait windows.
      const exp = Math.min(8, attempt++);
      const base = Math.min(200, retryDelayMs * Math.pow(2, exp));
      const jitter = 0.7 + Math.random() * 0.6; // 0.7x..1.3x
      const delay = Math.max(5, Math.floor(base * jitter));
      await new Promise((r) => setTimeout(r, delay));
    }

    try {
      return await fn();
    } finally {
      // Release only if token matches (avoids deleting someone else's lock if TTL expired and was reacquired).
      const releaseLua = `
        if redis.call("get", KEYS[1]) == ARGV[1] then
          return redis.call("del", KEYS[1])
        else
          return 0
        end
      `;
      this.client.eval(releaseLua, 1, k, token).catch(() => undefined);
    }
  }

  async onModuleDestroy() {
    try {
      await this.client.quit();
    } catch {
      this.client.disconnect();
    }
  }
}

