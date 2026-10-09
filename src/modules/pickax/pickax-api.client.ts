import { Injectable, Logger } from '@nestjs/common';

export const PICKAX_API_BASE = 'https://api.pickax.com/third-party/v1';

export class PickaxApiError extends Error {
  constructor(
    readonly status: number,
    private readonly code: string,
    message: string,
    private readonly retryAfterSeconds: number | null = null,
  ) {
    super(message);
  }

  /** Credentials are wrong or revoked; retrying cannot help. */
  get isAuthFailure(): boolean {
    return this.status === 401 || this.status === 403;
  }

  get isRetryable(): boolean {
    return this.status === 429 || this.status >= 500 || this.status === 0;
  }
}

export type PickaxTokenPair = {
  accessToken: string;
  refreshToken: string | null;
  expiresInSeconds: number;
  /** Top-level field names of the token response, for diagnosing missing identity. Never values. */
  responseKeys: string[];
};

export type PickaxPostPayload = {
  content: string;
  link?: string | null;
  attachments?: Array<{ url: string; name?: string }>;
};

export type PickaxArticlePayload = {
  title: string;
  content: string;
  thumbnail?: string | null;
};

export function extractRemoteId(json: unknown): string | null {
  if (!json || typeof json !== 'object') return null;
  const o = json as Record<string, unknown>;
  const nested = [o, o.data, o.post, o.article].filter((v): v is Record<string, unknown> => !!v && typeof v === 'object');
  for (const n of nested) {
    for (const key of ['id', 'postId', 'articleId']) {
      const v = n[key];
      if (typeof v === 'string' && v.trim()) return v.trim();
      if (typeof v === 'number' && Number.isFinite(v)) return String(v);
    }
  }
  return null;
}

/** Thin HTTP wrapper over the Pickax third-party API. Holds no credentials. */
@Injectable()
export class PickaxApiClient {
  private readonly logger = new Logger(PickaxApiClient.name);

  async exchangeCredentials(clientId: string, clientSecret: string): Promise<PickaxTokenPair> {
    const json = await this.request('POST', '/auth/token', { body: { clientId, clientSecret } });
    return this.parseTokens(json);
  }

  async refresh(refreshToken: string): Promise<PickaxTokenPair> {
    const json = await this.request('POST', '/auth/refresh', { body: { refreshToken } });
    return this.parseTokens(json);
  }

  async createPost(accessToken: string, idempotencyKey: string, payload: PickaxPostPayload): Promise<string | null> {
    return extractRemoteId(await this.request('POST', '/posts', { accessToken, idempotencyKey, body: payload }));
  }

  async updatePost(accessToken: string, idempotencyKey: string, remoteId: string, payload: Partial<PickaxPostPayload>): Promise<void> {
    await this.request('PUT', `/posts/${encodeURIComponent(remoteId)}`, { accessToken, idempotencyKey, body: payload });
  }

  async createArticle(accessToken: string, idempotencyKey: string, payload: PickaxArticlePayload): Promise<string | null> {
    return extractRemoteId(await this.request('POST', '/articles', { accessToken, idempotencyKey, body: payload }));
  }

  async updateArticle(accessToken: string, idempotencyKey: string, remoteId: string, payload: Partial<PickaxArticlePayload>): Promise<void> {
    await this.request('PUT', `/articles/${encodeURIComponent(remoteId)}`, { accessToken, idempotencyKey, body: payload });
  }

  async deleteContent(accessToken: string, kind: 'posts' | 'articles', id: string) {
    try {
      const result = await this.request('DELETE', `/${kind}/${encodeURIComponent(id)}`, { accessToken }) as { data?: { deleted?: boolean } } | null;
      if (result?.data?.deleted !== true) throw new PickaxApiError(502, 'removal_unconfirmed', 'Pickax did not confirm removal.');
    }
    catch (e) { if (!(e instanceof PickaxApiError) || e.status !== 404) throw e; }
  }

  private parseTokens(json: unknown): PickaxTokenPair {
    const o = (json && typeof json === 'object' ? json : {}) as Record<string, unknown>;
    const accessToken = typeof o.accessToken === 'string' ? o.accessToken : '';
    if (!accessToken) throw new PickaxApiError(502, 'bad_response', 'Pickax did not return an access token.');
    const expiresIn = typeof o.expiresIn === 'number' && o.expiresIn > 0 ? o.expiresIn : 3600;
    return {
      accessToken,
      refreshToken: typeof o.refreshToken === 'string' && o.refreshToken ? o.refreshToken : null,
      expiresInSeconds: expiresIn,
      responseKeys: Object.keys(o),
    };
  }

  private async request(
    method: 'POST' | 'PUT' | 'DELETE',
    path: string,
    opts: { body?: unknown; accessToken?: string; idempotencyKey?: string },
  ): Promise<unknown> {
    const headers: Record<string, string> = { 'Content-Type': 'application/json' };
    if (opts.accessToken) headers.Authorization = `Bearer ${opts.accessToken}`;
    if (opts.idempotencyKey) headers['Idempotency-Key'] = opts.idempotencyKey;

    let res: Response;
    try {
      res = await fetch(`${PICKAX_API_BASE}${path}`, {
        method,
        redirect: 'error',
        headers,
        body: JSON.stringify(opts.body),
        signal: AbortSignal.timeout(20_000),
      });
    } catch (err) {
      throw new PickaxApiError(0, 'network_error', err instanceof Error ? err.message : 'Could not reach Pickax.');
    }

    const text = await res.text();
    let json: unknown = null;
    try {
      json = text ? JSON.parse(text) : null;
    } catch {
      json = null;
    }

    if (!res.ok) {
      const err = (json as { error?: { code?: string; message?: string } } | null)?.error;
      const retryAfter = Number(res.headers.get('retry-after'));
      // Log rejections too (never for /auth/, whose bodies carry tokens): a bare "Internal server
      // error" from Pickax is undiagnosable without the response body.
      if (!path.startsWith('/auth/')) {
        this.logger.warn(`${method} ${path} -> ${res.status}`);
      }
      throw new PickaxApiError(
        res.status,
        err?.code ?? 'request_failed',
        err?.message ?? `Pickax responded with ${res.status}.`,
        Number.isFinite(retryAfter) && retryAfter > 0 ? retryAfter : null,
      );
    }
    // Auth responses carry tokens, so only content writes are logged.
    if (!path.startsWith('/auth/')) this.logger.log(`${method} ${path} -> ${res.status}`);
    if (method === 'DELETE' && res.status === 204) return { data: { deleted: true } };
    return json;
  }
}
