/** Gmail one-click POSTs `List-Unsubscribe=One-Click` and puts the token in the query. */
export function tokenFromUnsubscribeRequest(queryToken: unknown, body: unknown): string {
  if (typeof body === 'object' && body && !Array.isArray(body) && 'token' in body) {
    const fromBody = String((body as { token?: unknown }).token ?? '').trim();
    if (fromBody) return fromBody;
  }
  return String(queryToken ?? '').trim();
}

export function isOneClickUnsubscribePath(rawPath: string): boolean {
  const path = String(rawPath ?? '').replace(/^\/v\d+\/?/, '/');
  return path === '/email/unsubscribe' || path.startsWith('/email/unsubscribe?');
}

export function newsletterListId(frontendBaseUrl: string): string {
  let host = 'menofhunger.com';
  try {
    const parsed = new URL(frontendBaseUrl);
    if (parsed.hostname) host = parsed.hostname;
  } catch {
    // keep default
  }
  return `Men of Hunger Newsletter <newsletter.${host}>`;
}

export function oneClickUnsubscribeUrl(apiBaseUrl: string, token: string): string {
  const base = apiBaseUrl.replace(/\/$/, '');
  return `${base}/email/unsubscribe?token=${encodeURIComponent(token)}`;
}
