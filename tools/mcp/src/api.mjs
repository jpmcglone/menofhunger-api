import { workspaceReads } from './admin-catalog.mjs';
import { configuredBaseUrl } from './config.mjs';

const COOKIE = 'moh_session';
const MAX_RESPONSE_BYTES = 2_000_000;
const GET_PATHS = [
  /^admin\/delegation(?:\/jobs\/[A-Za-z0-9_-]+(?:\/drafts)?)?$/,
  /^auth\/me$/,
  /^auth\/accounts$/,
  /^posts\/[A-Za-z0-9_-]+$/,
  /^admin\/analytics(?:\/referrals)?$/,
  /^admin\/users\/search$/,
  /^admin\/users\/by-username\/[A-Za-z0-9_-]+$/,
  /^admin\/users\/[A-Za-z0-9_-]+\/(?:subscription-grants|referral)$/,
  /^admin\/(?:feedback|reports)$/,
  /^admin\/jobs\/queues$/,
  /^admin\/newsletters(?:\/[A-Za-z0-9_-]+)?$/,
  /^admin\/operations\/(?:health|content|members\/[A-Za-z0-9_-]+)$/,
];
const AUTH_PATHS = new Set([
  'auth/phone/start',
  'auth/phone/verify',
  'auth/logout',
]);

export class ApiError extends Error {
  constructor(message, status = 0) {
    super(message);
    this.status = status;
  }
}

export function normalizeBaseUrl(input = configuredBaseUrl()) {
  const url = new URL(input);
  const local = ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname);
  if (
    (url.protocol !== 'https:' && !(local && url.protocol === 'http:')) ||
    url.username ||
    url.password ||
    url.search ||
    url.hash ||
    !/^\/v1\/?$/.test(url.pathname)
  ) {
    throw new Error(
      'MOH_API_BASE_URL must be an HTTPS API URL ending in /v1 (HTTP allowed only on localhost).',
    );
  }
  return url.href.replace(/\/$/, '');
}

export class MohApi {
  constructor({
    store,
    baseUrl = process.env.MOH_API_BASE_URL,
    fetchImpl = fetch,
  } = {}) {
    this.baseUrl = normalizeBaseUrl(baseUrl);
    this.store = store;
    this.fetch = fetchImpl;
    this.credentials = store.credentialName(this.baseUrl);
  }

  async session() {
    const session = await this.store.read(this.credentials);
    if (!session) return null;
    if (
      session.baseUrl !== this.baseUrl ||
      !/^[A-Za-z0-9._~%+-]+$/.test(session.token || '') ||
      !Number.isFinite(Date.parse(session.expiresAt)) ||
      Date.parse(session.expiresAt) <= Date.now()
    )
      return null;
    return session;
  }

  async get(path, query = {}) {
    if (!GET_PATHS.some((pattern) => pattern.test(path)) &&
        !Object.values(workspaceReads).some((entry) => entry.path === path))
      throw new ApiError('API route is not available to this MCP.');
    return this.request(path, { query });
  }

  async auth(path, body) {
    if (!AUTH_PATHS.has(path))
      throw new ApiError('Unsupported login operation.');
    return this.request(path, {
      method: 'POST',
      body,
      anonymous: path !== 'auth/logout',
    });
  }

  // Deliberately narrower than an arbitrary HTTP mutation tool. Callers must
  // verify the administrator and requested author before invoking these routes.
  async publish(body) {
    return this.request('posts', { method: 'POST', body });
  }

  async switchAccount(userId) {
    if (!/^[A-Za-z0-9_-]{1,64}$/.test(userId))
      throw new ApiError('Invalid publishing account.');
    return this.request('auth/switch', { method: 'POST', body: { userId } });
  }

  async accountExists(phone) {
    const result = await this.request('auth/phone/exists', {
      query: { phone },
      anonymous: true,
    });
    return result.data?.exists === true;
  }

  async request(
    path,
    { query = {}, method = 'GET', body, anonymous = false } = {},
  ) {
    const session = anonymous ? null : await this.session();
    if (!anonymous && !session)
      throw new ApiError(
        'Men of Hunger is not signed in. Run the MCP login command in your terminal.',
        401,
      );
    const url = new URL(`${this.baseUrl}/${path}`);
    for (const [key, value] of Object.entries(query))
      if (value !== undefined && value !== null)
        url.searchParams.set(key, String(value));
    const headers = {
      Accept: 'application/json',
      Origin: new URL(this.baseUrl).origin,
    };
    if (session) headers.Cookie = `${COOKIE}=${session.token}`;
    if (body !== undefined) headers['Content-Type'] = 'application/json';
    let response;
    let text;
    try {
      response = await this.fetch(url, {
        method,
        headers,
        body: body === undefined ? undefined : JSON.stringify(body),
        redirect: 'error',
        signal: AbortSignal.timeout(25_000),
      });
      if (!response.headers.get('content-type')?.includes('application/json'))
        throw new ApiError(
          'API returned a non-JSON response.',
          response.status,
        );
      const reader = response.body.getReader();
      const chunks = [];
      let bytes = 0;
      try {
        while (true) {
          const { value, done } = await reader.read();
          if (done) break;
          bytes += value.byteLength;
          if (bytes > MAX_RESPONSE_BYTES) {
            await reader.cancel();
            throw new ApiError('API result is too large. Narrow the query.');
          }
          chunks.push(value);
        }
      } finally {
        reader.releaseLock();
      }
      text = Buffer.concat(chunks).toString('utf8');
    } catch (error) {
      if (error instanceof ApiError) throw error;
      throw new ApiError(
        'Men of Hunger could not be reached within 25 seconds. No request was retried.',
      );
    }
    if (!response.ok) {
      // Do not echo raw provider errors, request headers, or user-entered search strings.
      const messages = {
        400: 'The API rejected these parameters. Check the query and cursor.',
        401: 'Your session expired. Run the MCP login command again.',
        403: 'The API denied this request. Check account permissions and API origin.',
        404: 'This resource or admin endpoint is unavailable. Check admin access and whether the API update is deployed.',
        429: 'Men of Hunger rate-limited the request. Try again later.',
      };
      let postError;
      if (method === 'POST' && path === 'posts' && [400, 403, 404].includes(response.status)) {
        try {
          const errors = JSON.parse(text)?.meta?.errors;
          if (Array.isArray(errors)) postError = errors.filter(e => typeof e.message === 'string').map(e => e.message).join(' ').slice(0, 1000);
        } catch { /* Fall back to the safe status message. */ }
      }
      throw new ApiError(
        postError || messages[response.status] ||
          `Men of Hunger API returned HTTP ${response.status}.`,
        response.status,
      );
    }
    let payload;
    try {
      payload = JSON.parse(text);
    } catch {
      throw new ApiError('API returned invalid JSON.');
    }
    if (
      !payload ||
      typeof payload !== 'object' ||
      !Object.hasOwn(payload, 'data')
    )
      throw new ApiError(
        'API response did not contain the expected data envelope.',
      );
    // Accept only this API's one session cookie; never send credentials to redirected hosts.
    for (const cookie of response.headers.getSetCookie()) {
      const match = cookie.match(/^moh_session=([^;]+)(?:;|$)/);
      if (!match) continue;
      const expiry = cookie.match(/(?:^|;)\s*Expires=([^;]+)/i)?.[1];
      const expiresAt = expiry
        ? new Date(expiry).toISOString()
        : session?.expiresAt;
      if (!expiresAt || !/^[A-Za-z0-9._~%+-]+$/.test(match[1])) continue;
      await this.store.write(this.credentials, {
        baseUrl: this.baseUrl,
        token: match[1],
        expiresAt,
      });
    }
    return {
      ...payload,
      source: { url: url.href, fetchedAt: new Date().toISOString() },
    };
  }

  async identity() {
    const result = await this.get('auth/me');
    const user = result.data;
    if (!user?.siteAdmin || user.impersonation || user.accountSwitch) {
      throw new ApiError(
        'Sign in as your own Men of Hunger site administrator account.',
        403,
      );
    }
    // An admin-only read confirms the server guard, including impersonation restrictions.
    await this.get('admin/feedback', { limit: 1 });
    return {
      id: user.id,
      username: user.username,
      name: user.name,
      siteAdmin: true,
      source: result.source,
    };
  }
}

const OMIT_KEYS =
  /^(?:phone|email|birthdate|submitterIp|token|tokenHash|sessionToken|password|secret|authorization|cookie|stripeCustomerId|stripeSubscriptionId|appleOriginalTransactionId|sensitive|canRevealSensitive)$/i;
export function sanitize(value) {
  if (Array.isArray(value)) return value.map(sanitize);
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value)
        .filter(([key]) => !OMIT_KEYS.test(key))
        .map(([key, entry]) => [key, sanitize(entry)]),
    );
  }
  return value;
}
