import { createHash, createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';
import {
  InvalidClientMetadataError, InvalidGrantError, InvalidScopeError,
  InvalidTargetError, InvalidTokenError, InvalidRequestError,
} from '@modelcontextprotocol/sdk/server/auth/errors.js';

export const READ_SCOPE = 'moh:read';
const DAY = 86400;
const opaque = () => randomBytes(32).toString('base64url');
const digest = (value) => createHash('sha256').update(value).digest('hex');

// Redis is shared across API instances. Tokens are indexed by hash; session material
// and OAuth client secrets are encrypted with a domain-separated application key.
export class OAuthStore {
  constructor(redis, secret) {
    this.redis = redis;
    this.key = createHash('sha256').update(`moh-mcp-oauth-v1:${secret}`).digest();
  }
  keyFor(kind, token) { return `moh:mcp:oauth:${kind}:${digest(token)}`; }
  async put(kind, token, value, ttl) {
    const key = this.keyFor(kind, token);
    const iv = randomBytes(12);
    const cipher = createCipheriv('aes-256-gcm', this.key, iv);
    cipher.setAAD(Buffer.from(key));
    const ciphertext = Buffer.concat([cipher.update(JSON.stringify(value)), cipher.final()]);
    const encoded = Buffer.concat([iv, cipher.getAuthTag(), ciphertext]).toString('base64url');
    await this.redis.set(key, encoded, 'EX', Math.max(1, Math.floor(ttl)));
  }
  async get(kind, token, consume = false) {
    if (typeof token !== 'string' || token.length > 200) return null;
    const key = this.keyFor(kind, token);
    const encoded = consume
      ? await this.redis.getdel(key)
      : await this.redis.get(key);
    if (!encoded) return null;
    const buffer = Buffer.from(encoded, 'base64url');
    const decipher = createDecipheriv('aes-256-gcm', this.key, buffer.subarray(0, 12));
    decipher.setAAD(Buffer.from(key));
    decipher.setAuthTag(buffer.subarray(12, 28));
    return JSON.parse(Buffer.concat([decipher.update(buffer.subarray(28)), decipher.final()]).toString());
  }
  async remove(kind, token) { await this.redis.del(this.keyFor(kind, token)); }
}

export class MohOAuthProvider {
  constructor({ store, resourceUrl, resolveAdmin, createSession, revokeSession }) {
    Object.assign(this, { store, resourceUrl, resolveAdmin, createSession, revokeSession });
    this.clientsStore = {
      getClient: (id) => store.get('client', id),
      registerClient: async (client) => {
        // This is a private founder integration. DCR cannot introduce arbitrary
        // redirect hosts; each registered callback still needs an exact match.
        if (!client.redirect_uris?.length || client.redirect_uris.length > 5 ||
          !client.redirect_uris.every((uri) => {
            const url = new URL(uri);
            return url.origin === 'https://chatgpt.com' && !url.search && !url.hash &&
              (url.pathname === '/connector_platform_oauth_redirect' ||
                /^\/connector\/oauth\/[A-Za-z0-9_-]+$/.test(url.pathname));
          })) throw new InvalidClientMetadataError('Use the ChatGPT OAuth callback URL shown in connection settings.');
        if (client.scope && client.scope !== READ_SCOPE) throw new InvalidScopeError('Only moh:read is supported.');
        if (client.client_name?.length > 200) throw new InvalidClientMetadataError('Client name is too long.');
        if (!client.client_id) throw new InvalidClientMetadataError('Missing client ID.');
        await store.put('client', client.client_id, client, 90 * DAY);
        return client;
      },
    };
  }

  checkResource(resource, required = false) {
    if ((required && !resource) || (resource && String(resource) !== this.resourceUrl))
      throw new InvalidTargetError('Resource must match this Men of Hunger MCP endpoint.');
  }
  checkScopes(scopes) {
    if (scopes?.some((scope) => scope !== READ_SCOPE))
      throw new InvalidScopeError('Only moh:read is supported.');
  }
  async authorize(client, params, res) {
    this.checkResource(params.resource, true);
    this.checkScopes(params.scopes);
    if (!/^[A-Za-z0-9_-]{43}$/.test(params.codeChallenge) || (params.state?.length ?? 0) > 2000)
      throw new InvalidRequestError('Invalid authorization parameters.');
    const request = opaque();
    const csrf = opaque();
    await this.store.put('request', request, {
      clientId: client.client_id, clientName: client.client_name || 'ChatGPT',
      redirectUri: params.redirectUri, state: params.state,
      challenge: params.codeChallenge, csrfHash: digest(csrf), resourceUrl: this.resourceUrl,
    }, 600);
    res.cookie('moh_mcp_consent', csrf, {
      httpOnly: true, secure: new URL(this.resourceUrl).protocol === 'https:',
      sameSite: 'lax', path: '/mcp/consent', maxAge: 600_000,
    });
    res.redirect(302, `/mcp/consent?request=${request}`);
  }
  async consentRequest(request, csrf) {
    const pending = await this.store.get('request', request);
    if (!pending || pending.resourceUrl !== this.resourceUrl || typeof csrf !== 'string' || pending.csrfHash !== digest(csrf))
      throw new InvalidRequestError('Connection request expired. Start again from ChatGPT.');
    return pending;
  }
  async consent(request, csrf, sessionToken, allow) {
    const pending = await this.consentRequest(request, csrf);
    const admin = await this.resolveAdmin(sessionToken);
    if (!admin) throw new InvalidGrantError('Sign in with your own site administrator account.');
    // Consume only after auth/CSRF validation. GETDEL prevents simultaneous approvals.
    if (!(await this.store.get('request', request, true)))
      throw new InvalidRequestError('Connection request was already used.');
    const callback = new URL(pending.redirectUri);
    if (pending.state) callback.searchParams.set('state', pending.state);
    if (!allow) {
      callback.searchParams.set('error', 'access_denied');
      return callback.href;
    }
    const code = opaque();
    // Create the dedicated product session only when the code is redeemed.
    // Binding the code to the approving browser session rechecks admin privileges then.
    await this.store.put('code', code, { ...pending, sessionToken, userId: admin.id }, 120);
    callback.searchParams.set('code', code);
    return callback.href;
  }
  async codeFor(client, code) {
    const value = await this.store.get('code', code);
    if (!value || value.resourceUrl !== this.resourceUrl || value.clientId !== client.client_id) throw new InvalidGrantError('Invalid authorization code.');
    return value;
  }
  async challengeForAuthorizationCode(client, code) {
    return (await this.codeFor(client, code)).challenge;
  }
  async exchangeAuthorizationCode(client, code, _verifier, redirectUri, resource) {
    this.checkResource(resource);
    const pending = await this.codeFor(client, code);
    if (redirectUri !== pending.redirectUri) throw new InvalidGrantError('Redirect URI does not match.');
    const admin = await this.resolveAdmin(pending.sessionToken);
    if (!admin || admin.id !== pending.userId) throw new InvalidGrantError('Administrator session is no longer valid.');
    if (!(await this.store.get('code', code, true))) throw new InvalidGrantError('Authorization code was already used.');
    const session = await this.createSession(admin.id);
    const grantId = opaque();
    const grant = { clientId: client.client_id, userId: admin.id, sessionToken: session.token, resourceUrl: this.resourceUrl,
      expiresAt: Math.min(Date.now() / 1000 + 30 * DAY, Date.parse(session.expiresAt) / 1000) };
    try {
      await this.store.put('grant', grantId, grant, grant.expiresAt - Date.now() / 1000);
      return await this.issueTokens(grantId, grant);
    } catch (error) {
      await this.revokeSession(session.token);
      throw error;
    }
  }
  async grantFor(grantId) {
    const grant = await this.store.get('grant', grantId);
    if (!grant || grant.resourceUrl !== this.resourceUrl || grant.expiresAt <= Date.now() / 1000) throw new InvalidGrantError('Connection expired. Reconnect in ChatGPT.');
    const admin = await this.resolveAdmin(grant.sessionToken);
    if (!admin || admin.id !== grant.userId) throw new InvalidGrantError('Administrator access was revoked.');
    return grant;
  }
  async issueTokens(grantId, grant) {
    const access = opaque();
    const refresh = opaque();
    const ttl = Math.min(900, Math.floor(grant.expiresAt - Date.now() / 1000));
    await this.store.put('access', access, { grantId, expiresAt: Math.floor(Date.now() / 1000) + ttl }, ttl);
    await this.store.put('refresh', refresh, { grantId, clientId: grant.clientId }, grant.expiresAt - Date.now() / 1000);
    return { access_token: access, token_type: 'Bearer', expires_in: ttl, refresh_token: refresh, scope: READ_SCOPE };
  }
  async exchangeRefreshToken(client, token, scopes, resource) {
    this.checkResource(resource);
    this.checkScopes(scopes);
    const refresh = await this.store.get('refresh', token);
    if (!refresh || refresh.clientId !== client.client_id) throw new InvalidGrantError('Invalid refresh token.');
    const grant = await this.grantFor(refresh.grantId);
    if (!(await this.store.get('refresh', token, true))) throw new InvalidGrantError('Refresh token was already used.');
    return this.issueTokens(refresh.grantId, grant);
  }
  async verifyAccessToken(token) {
    const access = await this.store.get('access', token);
    if (!access) throw new InvalidTokenError('Invalid or expired MCP token.');
    let grant;
    try { grant = await this.grantFor(access.grantId); }
    catch (error) {
      if (error instanceof InvalidGrantError) throw new InvalidTokenError('Connection expired or administrator access revoked.');
      throw error;
    }
    return { token, clientId: grant.clientId, scopes: [READ_SCOPE], expiresAt: access.expiresAt,
      resource: new URL(this.resourceUrl), extra: { sessionToken: grant.sessionToken, userId: grant.userId } };
  }
  async revokeToken(client, { token }) {
    const record = await this.store.get('refresh', token) || await this.store.get('access', token);
    if (!record) return;
    const grant = await this.store.get('grant', record.grantId);
    if (!grant || grant.resourceUrl !== this.resourceUrl || grant.clientId !== client.client_id) return;
    await this.store.remove('grant', record.grantId);
    await this.revokeSession(grant.sessionToken);
  }
}
