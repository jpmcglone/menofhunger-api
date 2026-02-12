type TokenUserCacheEntry = { userId: string | null; expiresAtMs: number };

const tokenHashToUserCache = new Map<string, TokenUserCacheEntry>();
const CACHE_MAX_ENTRIES = 5000;

export function readSessionTokenUserCache(tokenHash: string, nowMs: number): string | null | undefined {
  const hit = tokenHashToUserCache.get(tokenHash);
  if (!hit) return undefined;
  if (hit.expiresAtMs <= nowMs) {
    tokenHashToUserCache.delete(tokenHash);
    return undefined;
  }
  return hit.userId;
}

export function writeSessionTokenUserCache(tokenHash: string, entry: TokenUserCacheEntry, nowMs: number) {
  tokenHashToUserCache.set(tokenHash, entry);
  pruneSessionTokenUserCache(nowMs);
}

export function invalidateSessionTokenUserCache(tokenHash: string | null | undefined) {
  const key = (tokenHash ?? '').trim();
  if (!key) return;
  tokenHashToUserCache.delete(key);
}

export function pruneSessionTokenUserCache(nowMs: number) {
  for (const [k, v] of tokenHashToUserCache) {
    if (v.expiresAtMs <= nowMs) tokenHashToUserCache.delete(k);
  }
  while (tokenHashToUserCache.size > CACHE_MAX_ENTRIES) {
    const firstKey = tokenHashToUserCache.keys().next().value as string | undefined;
    if (!firstKey) break;
    tokenHashToUserCache.delete(firstKey);
  }
}
