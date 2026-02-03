/**
 * Typed access to the session cookie. cookie-parser populates req.cookies at runtime;
 * Express Request types don't include cookies by default.
 */
export type RequestWithCookies = { cookies?: Record<string, string | undefined> };

export function getSessionCookie(req: RequestWithCookies): string | undefined {
  const raw = req.cookies?.moh_session;
  return typeof raw === 'string' && raw.trim() ? raw.trim() : undefined;
}
