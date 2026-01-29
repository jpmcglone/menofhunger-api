import type { ExecutionContext } from '@nestjs/common';

type RateLimitEntry = { limit: number; ttl: number };

function getEntry(ctx: ExecutionContext, key: string): RateLimitEntry | null {
  try {
    const req = ctx.switchToHttp().getRequest();
    const app = req?.app as { locals?: Record<string, unknown> } | undefined;
    const store = app?.locals?.mohRateLimits as Record<string, RateLimitEntry> | undefined;
    const entry = store?.[key];
    if (!entry) return null;
    if (!Number.isFinite(entry.limit) || entry.limit <= 0) return null;
    if (!Number.isFinite(entry.ttl) || entry.ttl <= 0) return null;
    return entry;
  } catch {
    return null;
  }
}

export function rateLimitLimit(key: string, fallback: number) {
  return (ctx: ExecutionContext) => getEntry(ctx, key)?.limit ?? fallback;
}

export function rateLimitTtl(key: string, fallback: number) {
  return (ctx: ExecutionContext) => getEntry(ctx, key)?.ttl ?? fallback;
}

