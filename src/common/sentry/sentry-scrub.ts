const REDACTED = '[REDACTED]';

const SENSITIVE_HEADER_KEYS = new Set([
  'authorization',
  'cookie',
  'set-cookie',
  'x-api-key',
  'x-auth-token',
  'x-access-token',
  'x-refresh-token',
  'proxy-authorization',
  'x-csrf-token',
  'x-xsrf-token',
  'x-session-id',
  'stripe-signature',
]);

const SENSITIVE_QUERY_KEYS = new Set([
  'password',
  'token',
  'accesstoken',
  'refreshtoken',
  'idtoken',
  'sessiontoken',
  'code',
  'state',
  'secret',
  'apikey',
  'otp',
  'phone',
  'email',
]);

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function normalizeKey(key: string): string {
  return key.toLowerCase().replace(/[_-]/g, '');
}

function scrubHeaders(headers: unknown): unknown {
  if (!isPlainObject(headers)) return headers;
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(headers)) {
    out[key] = SENSITIVE_HEADER_KEYS.has(key.toLowerCase()) ? REDACTED : value;
  }
  return out;
}

function scrubQuery(query: string): string {
  const params = new URLSearchParams(query);
  for (const key of Array.from(params.keys())) {
    if (SENSITIVE_QUERY_KEYS.has(normalizeKey(key))) params.set(key, REDACTED);
  }
  return params.toString();
}

function scrubUrl(url: unknown): unknown {
  if (typeof url !== 'string') return url;
  const index = url.indexOf('?');
  if (index < 0) return url;
  return `${url.slice(0, index)}?${scrubQuery(url.slice(index + 1))}`;
}

/**
 * Request bodies carry phone numbers, OTP codes, message text, and post bodies, so they are
 * dropped rather than key-scrubbed. Only `user.id` identifies the member.
 */
export function scrubSentryEvent<T extends object>(event: T): T {
  const e = event as Record<string, unknown>;
  const request = e.request;
  if (isPlainObject(request)) {
    delete request.data;
    delete request.cookies;
    if ('headers' in request) request.headers = scrubHeaders(request.headers);
    if ('url' in request) request.url = scrubUrl(request.url);
    if (typeof request.query_string === 'string') request.query_string = scrubQuery(request.query_string);
  }
  if (isPlainObject(e.user)) {
    e.user = typeof e.user.id === 'string' ? { id: e.user.id } : {};
  }
  if (Array.isArray(e.breadcrumbs)) {
    e.breadcrumbs = e.breadcrumbs.map((crumb: unknown) => {
      if (!isPlainObject(crumb) || !isPlainObject(crumb.data)) return crumb;
      const data = { ...crumb.data };
      if ('url' in data) data.url = scrubUrl(data.url);
      return { ...crumb, data };
    });
  }
  return event;
}
