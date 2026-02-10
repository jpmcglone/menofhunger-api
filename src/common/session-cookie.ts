/**
 * Typed access to the session cookie. cookie-parser populates req.cookies at runtime;
 * Express Request types don't include cookies by default.
 */
import { AUTH_COOKIE_NAME } from '../modules/auth/auth.constants';

export type RequestWithCookies = { cookies?: Record<string, string | undefined> };

export function getSessionCookie(req: RequestWithCookies): string | undefined {
  const raw = req.cookies?.[AUTH_COOKIE_NAME];
  return typeof raw === 'string' && raw.trim() ? raw.trim() : undefined;
}

/**
 * Parse the session cookie token from a raw Cookie header (e.g. WebSocket handshake).
 */
export function parseSessionCookieFromHeader(cookieHeader: string | undefined): string | undefined {
  if (!cookieHeader?.trim()) return undefined;
  const parts = cookieHeader.split(';').map((s) => s.trim());
  for (const part of parts) {
    const eq = part.indexOf('=');
    if (eq === -1) continue;
    const name = part.slice(0, eq).trim();
    if (name === AUTH_COOKIE_NAME) return part.slice(eq + 1).trim() || undefined;
  }
  return undefined;
}
