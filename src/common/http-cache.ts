import type { Response } from 'express';

/** Shared-cache-friendly public Cache-Control. `s-maxage` lets a future CDN HIT independently of browsers. */
export function publicCacheControl(maxAgeSeconds: number, staleWhileRevalidateSeconds = 0): string {
  const parts = [`public`, `max-age=${maxAgeSeconds}`, `s-maxage=${maxAgeSeconds}`];
  if (staleWhileRevalidateSeconds > 0) {
    parts.push(`stale-while-revalidate=${staleWhileRevalidateSeconds}`);
  }
  return parts.join(', ');
}

export function setReadCache(
  res: Response,
  opts: {
    viewerUserId: string | null;
    publicMaxAgeSeconds?: number;
    publicStaleWhileRevalidateSeconds?: number;
    /**
     * Max-age for authenticated (private) responses.
     * Defaults to 0, which emits `private, no-store` so the browser never serves
     * a stale personalized response after a mutation (boost, repost, bookmark, etc.).
     * Pass a positive value only for responses that are safe to cache briefly
     * even after user actions (e.g. a slow-changing count endpoint).
     */
    privateMaxAgeSeconds?: number;
    varyCookie?: boolean;
  },
) {
  const publicMaxAgeSeconds = opts.publicMaxAgeSeconds ?? 30;
  const publicSWRSeconds = opts.publicStaleWhileRevalidateSeconds ?? 60;
  const privateMaxAgeSeconds = opts.privateMaxAgeSeconds ?? 0;
  const varyCookie = opts.varyCookie ?? true;

  // Authenticated responses are personalized (viewerHasBoosted, viewerHasReposted, etc.).
  // Using no-store prevents the browser from serving stale personalized data after
  // a mutation (boost/repost/bookmark) when the user refreshes within the cache window.
  // Public (anonymous) responses are safe to cache via shared CDN/proxy.
  const cacheControl = opts.viewerUserId
    ? privateMaxAgeSeconds > 0
      ? `private, max-age=${privateMaxAgeSeconds}`
      : `private, no-store`
    : publicCacheControl(publicMaxAgeSeconds, publicSWRSeconds);

  res.setHeader('Cache-Control', cacheControl);
  if (varyCookie) {
    // Extra safety for shared caches/proxies that might otherwise key only by URL.
    res.setHeader('Vary', 'Cookie');
  }
}

