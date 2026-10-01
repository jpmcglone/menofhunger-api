import { xContainsLink } from '../../common/crosspost/crosspost-eligibility';
import { createHash, randomBytes } from 'crypto';
import { Injectable, Logger } from '@nestjs/common';

export const X_AUTHORIZE_URL = 'https://x.com/i/oauth2/authorize';
export const X_API_BASE = 'https://api.x.com';
export const X_SCOPES = ['tweet.read', 'tweet.write', 'users.read', 'media.write', 'offline.access'];

export class XApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
    /** True when a retry could post a second copy. The worker records the error and stops. */
    readonly duplicateRisk = false,
  ) {
    super(message);
  }

  get isAuthFailure(): boolean {
    return this.status === 401 || this.status === 403;
  }

  /** Retry only when we know X did not accept the post. */
  get isRetryable(): boolean {
    return !this.duplicateRisk && (this.status === 429 || this.status >= 500);
  }
}

export type XTokenPair = {
  accessToken: string;
  refreshToken: string | null;
  expiresInSeconds: number;
  scope: string;
};

export type XAccount = { id: string; username: string };

export function pkceVerifier(): string {
  return randomBytes(32).toString('base64url');
}

export function pkceChallenge(verifier: string): string {
  return createHash('sha256').update(verifier).digest('base64url');
}

const REQUIRED_X_SCOPES = ['tweet.read', 'tweet.write', 'users.read', 'media.write', 'offline.access'];

/** X granted every scope this integration posts with. An empty scope list is not enough. */
export function hasRequiredXScopes(scope: string): boolean {
  const granted = new Set(scope.split(/\s+/).filter(Boolean));
  return REQUIRED_X_SCOPES.every((name) => granted.has(name));
}

/** Handles X will actually accept. Anything else is not stored on the profile. */
export function isXUsername(username: string): boolean {
  return /^[A-Za-z0-9_]{1,15}$/.test(username);
}

@Injectable()
export class XApiClient {
  private readonly logger = new Logger(XApiClient.name);

  authorizeUrl(input: {
    clientId: string;
    redirectUri: string;
    state: string;
    codeChallenge: string;
  }): string {
    const params = new URLSearchParams({
      response_type: 'code',
      client_id: input.clientId,
      redirect_uri: input.redirectUri,
      scope: X_SCOPES.join(' '),
      state: input.state,
      code_challenge: input.codeChallenge,
      code_challenge_method: 'S256',
    });
    return `${X_AUTHORIZE_URL}?${params.toString()}`;
  }

  async exchangeCode(input: {
    clientId: string;
    clientSecret: string;
    code: string;
    redirectUri: string;
    codeVerifier: string;
  }): Promise<XTokenPair> {
    return this.parseTokens(await this.tokenRequest(input.clientId, input.clientSecret, {
      grant_type: 'authorization_code',
      code: input.code,
      redirect_uri: input.redirectUri,
      code_verifier: input.codeVerifier,
    }));
  }

  async refresh(input: { clientId: string; clientSecret: string; refreshToken: string }): Promise<XTokenPair> {
    return this.parseTokens(await this.tokenRequest(input.clientId, input.clientSecret, {
      grant_type: 'refresh_token',
      refresh_token: input.refreshToken,
    }));
  }

  async revoke(input: { clientId: string; clientSecret: string; token: string }): Promise<void> {
    try {
      await this.tokenRequest(input.clientId, input.clientSecret, {
        token: input.token,
        token_type_hint: 'refresh_token',
      }, '/2/oauth2/revoke');
    } catch (err) {
      this.logger.warn(`X revoke failed: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  async getMe(accessToken: string): Promise<XAccount> {
    const json = await this.request('GET', '/2/users/me', { accessToken });
    const data = (json as { data?: { id?: unknown; username?: unknown } } | null)?.data;
    const id = typeof data?.id === 'string' ? data.id : '';
    const username = typeof data?.username === 'string' ? data.username.replace(/^@/, '') : '';
    if (!id || !username) throw new XApiError(502, 'bad_response', 'X did not return an account.');
    return { id, username };
  }

  async uploadImage(accessToken: string, file: { bytes: Buffer; contentType: string; alt: string | null }): Promise<string> {
    const form = new FormData();
    form.append('media', new Blob([new Uint8Array(file.bytes)], { type: file.contentType }), 'image');
    form.append('media_category', 'tweet_image');
    const json = await this.request('POST', '/2/media/upload', { accessToken, form });
    const data = (json as { data?: { id?: unknown } } | null)?.data;
    const id = typeof data?.id === 'string' ? data.id : '';
    if (!id) throw new XApiError(502, 'bad_response', 'X did not return a media id.');
    const alt = (file.alt ?? '').trim();
    if (alt) {
      await this.request('POST', '/2/media/metadata', {
        accessToken,
        body: { id, metadata: { alt_text: { text: alt.slice(0, 1000) } } },
      });
    }
    return id;
  }

  async createPost(accessToken: string, payload: { text: string; mediaIds?: string[] }): Promise<string> {
    if (xContainsLink(payload.text)) {
      throw new XApiError(400, 'links_unsupported', 'Remove any links to post to X.');
    }
    const body: Record<string, unknown> = { text: payload.text };
    if (payload.mediaIds?.length) body.media = { media_ids: payload.mediaIds };
    let json: unknown;
    try {
      json = await this.request('POST', '/2/tweets', { accessToken, body });
    } catch (err) {
      if (err instanceof XApiError && (err.status === 0 || err.status >= 500)) {
        throw new XApiError(0, err.code, err.message, true);
      }
      throw err;
    }
    const id = (json as { data?: { id?: unknown } } | null)?.data?.id;
    if (typeof id !== 'string' || !id) throw new XApiError(502, 'bad_response', 'X did not return a post id.', true);
    return id;
  }

  async deletePost(accessToken: string, id: string) {
    try {
      const result = await this.request('DELETE', `/2/tweets/${encodeURIComponent(id)}`, { accessToken }) as { data?: { deleted?: boolean } } | null;
      if (result?.data?.deleted !== true) throw new XApiError(502, 'removal_unconfirmed', 'X did not confirm removal.');
    }
    catch (e) { if (!(e instanceof XApiError) || e.status !== 404) throw e; }
  }

  private async tokenRequest(
    clientId: string,
    clientSecret: string,
    fields: Record<string, string>,
    path = '/2/oauth2/token',
  ): Promise<unknown> {
    const basic = Buffer.from(`${clientId}:${clientSecret}`).toString('base64');
    return this.request('POST', path, {
      bodyEncoded: new URLSearchParams(fields).toString(),
      basic,
    });
  }

  private parseTokens(json: unknown): XTokenPair {
    const o = (json && typeof json === 'object' ? json : {}) as Record<string, unknown>;
    const accessToken = typeof o.access_token === 'string' ? o.access_token : '';
    if (!accessToken) throw new XApiError(502, 'bad_response', 'X did not return an access token.');
    const expiresIn = typeof o.expires_in === 'number' && o.expires_in > 0 ? o.expires_in : 7200;
    return {
      accessToken,
      refreshToken: typeof o.refresh_token === 'string' && o.refresh_token ? o.refresh_token : null,
      expiresInSeconds: expiresIn,
      scope: typeof o.scope === 'string' ? o.scope : '',
    };
  }

  private async request(
    method: 'GET' | 'POST' | 'DELETE',
    path: string,
    opts: { accessToken?: string; basic?: string; body?: unknown; bodyEncoded?: string; form?: FormData },
  ): Promise<unknown> {
    const headers: Record<string, string> = {};
    if (opts.accessToken) headers.Authorization = `Bearer ${opts.accessToken}`;
    if (opts.basic) headers.Authorization = `Basic ${opts.basic}`;
    let body: BodyInit | undefined;
    if (opts.form) {
      body = opts.form;
    } else if (opts.bodyEncoded !== undefined) {
      headers['Content-Type'] = 'application/x-www-form-urlencoded';
      body = opts.bodyEncoded;
    } else if (opts.body !== undefined) {
      headers['Content-Type'] = 'application/json';
      body = JSON.stringify(opts.body);
    }

    let res: Response;
    try {
      res = await fetch(`${X_API_BASE}${path}`, {
        method,
        redirect: 'error',
        headers,
        body,
        signal: AbortSignal.timeout(20_000),
      });
    } catch (err) {
      throw new XApiError(0, 'network_error', err instanceof Error ? err.message : 'Could not reach X.');
    }

    const text = await res.text();
    let json: unknown = null;
    try {
      json = text ? JSON.parse(text) : null;
    } catch {
      json = null;
    }
    if (!res.ok) {
      const record = json as { detail?: string; title?: string; errors?: Array<{ message?: string }> } | null;
      const message = record?.errors?.[0]?.message || record?.detail || record?.title || `X responded with ${res.status}.`;
      throw new XApiError(res.status, 'request_failed', message);
    }
    if (!path.startsWith('/2/oauth2/')) this.logger.log(`${method} ${path} -> ${res.status}`);
    if (method === 'DELETE' && res.status === 204) return { data: { deleted: true } };
    return json;
  }
}
