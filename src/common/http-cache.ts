import type { Response } from 'express';

export function setReadCache(
  res: Response,
  opts: {
    viewerUserId: string | null;
    publicMaxAgeSeconds?: number;
    publicStaleWhileRevalidateSeconds?: number;
    privateMaxAgeSeconds?: number;
    varyCookie?: boolean;
  },
) {
  const publicMaxAgeSeconds = opts.publicMaxAgeSeconds ?? 30;
  const publicSWRSeconds = opts.publicStaleWhileRevalidateSeconds ?? 60;
  const privateMaxAgeSeconds = opts.privateMaxAgeSeconds ?? 15;
  const varyCookie = opts.varyCookie ?? true;

  // Avoid leaking personalized fields (boost/bookmark/admin internal) via shared caches.
  const cacheControl = opts.viewerUserId
    ? `private, max-age=${privateMaxAgeSeconds}`
    : publicSWRSeconds > 0
      ? `public, max-age=${publicMaxAgeSeconds}, stale-while-revalidate=${publicSWRSeconds}`
      : `public, max-age=${publicMaxAgeSeconds}`;

  res.setHeader('Cache-Control', cacheControl);
  if (varyCookie) {
    // Extra safety for shared caches/proxies that might otherwise key only by URL.
    res.setHeader('Vary', 'Cookie');
  }
}

