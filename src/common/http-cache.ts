import type { Response } from 'express';

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
    : publicSWRSeconds > 0
      ? `public, max-age=${publicMaxAgeSeconds}, stale-while-revalidate=${publicSWRSeconds}`
      : `public, max-age=${publicMaxAgeSeconds}`;

  res.setHeader('Cache-Control', cacheControl);
  if (varyCookie) {
    // Extra safety for shared caches/proxies that might otherwise key only by URL.
    res.setHeader('Vary', 'Cookie');
  }
}

