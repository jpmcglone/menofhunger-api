import { createHash, createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';
import {
  InvalidClientMetadataError, InvalidGrantError, InvalidScopeError,
  InvalidTargetError, InvalidTokenError, InvalidRequestError,
} from '@modelcontextprotocol/sdk/server/auth/errors.js';
import { forgetConnection, listConnections, recordConnection, revokeConnection, touchConnection } from './connections.mjs';

export const READ_SCOPE = 'moh:read';
export const WRITE_SCOPE = 'moh:write';
export const MEMBER_READ_SCOPE = 'moh:member:read';
const KNOWN_SCOPES = new Set([READ_SCOPE, WRITE_SCOPE, MEMBER_READ_SCOPE]);
const DAY = 86400;

/** Scopes are chosen by who approves, never by what the client asked for. */
export function scopesForAudience(audience) {
  return audience === 'member' ? [MEMBER_READ_SCOPE] : [READ_SCOPE, WRITE_SCOPE];
}

/** Older grants predate audiences and were always administrator grants. */
export const grantAudience = (grant) => grant?.audience === 'member' ? 'member' : 'admin';

// An admin can keep using a member grant; a member can never use an admin grant.
const accountSatisfies = (account, audience) =>
  Boolean(account) && (account.audience === 'admin' || (audience === 'member' && account.audience === 'member'));
const opaque = () => randomBytes(32).toString('base64url');
const digest = (value) => createHash('sha256').update(value).digest('hex');
/** Public connection ID: the grant's storage hash, never the grant ID itself. */
export const connectionIdFor = digest;

// Redis is shared across API instances. Tokens are indexed by hash; session material
// and OAuth client secrets are encrypted with a domain-separated application key.
export class OAuthStore {
  constructor(redis, secret) {
    this.redis = redis;
    this.key = createHash('sha256').update(`moh-mcp-oauth-v1:${secret}`).digest();
  }
  keyFor(kind, token) { return this.keyForDigest(kind, digest(token)); }
  keyForDigest(kind, hash) { return `moh:mcp:oauth:${kind}:${hash}`; }
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
    return this.read(this.keyFor(kind, token), consume);
  }
  async getByDigest(kind, hash) { return this.read(this.keyForDigest(kind, hash)); }
  async removeByDigest(kind, hash) { await this.redis.del(this.keyForDigest(kind, hash)); }
  async read(key, consume = false) {
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

/** Exact allowlisted OAuth redirect URIs for ChatGPT and Cursor MCP clients. */
export function isAllowedOAuthRedirectUri(uri) {
  let url;
  try { url = new URL(uri); } catch { return false; }
  if (url.search || url.hash) return false;
  if (url.protocol === 'https:' && url.origin === 'https://chatgpt.com') {
    return url.pathname === '/connector_platform_oauth_redirect' ||
      /^\/connector\/oauth\/[A-Za-z0-9_-]+$/.test(url.pathname);
  }
  // Cursor/Grok DCR often sends several of these together. Rejecting one URI
  // rejects the whole registration, so keep the Grok Bot / Cloud extras here.
  if ((url.origin === 'https://www.cursor.com' || url.origin === 'https://cursor.com') &&
    (url.pathname === '/agents/mcp/oauth/callback' || url.pathname === '/bot/mcp/oauth/callback'))
    return true;
  if (url.href === 'http://localhost:8787/callback' || url.href === 'http://127.0.0.1:8787/callback') return true;
  if (url.href === 'cursor://anysphere.cursor-mcp/oauth/callback') return true;
  if (url.href === 'cursor-nightly://anysphere.cursor-mcp/oauth/callback') return true;
  if (url.href === 'grokbot://mcp/oauth/callback') return true;
  return false;
}

export const MAX_OAUTH_REDIRECT_URIS = 10;

export class MohOAuthProvider {
  constructor({ store, resourceUrl, resolveAccount, resolveAdmin, createSession, revokeSession }) {
    resolveAccount ??= async (token) => {
      const admin = await resolveAdmin(token);
      return admin ? { ...admin, audience: 'admin' } : null;
    };
    Object.assign(this, { store, resourceUrl, resolveAccount, createSession, revokeSession });
    this.clientsStore = {
      getClient: (id) => store.get('client', id),
      registerClient: async (client) => {
        // DCR cannot introduce arbitrary redirect hosts; each registered
        // callback still needs an exact match.
        if (!client.redirect_uris?.length || client.redirect_uris.length > MAX_OAUTH_REDIRECT_URIS ||
          !client.redirect_uris.every(isAllowedOAuthRedirectUri))
          throw new InvalidClientMetadataError('Use an allowlisted ChatGPT or Cursor OAuth callback URL shown in connection settings.');
        this.checkScopes(client.scope?.split(' '));
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
    if (scopes?.some((scope) => !KNOWN_SCOPES.has(scope)))
      throw new InvalidScopeError('Only moh:read, moh:write, and moh:member:read are supported.');
  }
  async authorize(client, params, res) {
    this.checkResource(params.resource, true);
    this.checkScopes(params.scopes);
    if (!/^[A-Za-z0-9_-]{43}$/.test(params.codeChallenge) || (params.state?.length ?? 0) > 2000)
      throw new InvalidRequestError('Invalid authorization parameters.');
    const request = opaque();
    const csrf = opaque();
    await this.store.put('request', request, {
      clientId: client.client_id, clientName: client.client_name || 'MCP client',
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
      throw new InvalidRequestError('Connection request expired. Start again from your MCP client.');
    return pending;
  }
  async consent(request, csrf, sessionToken, allow) {
    const pending = await this.consentRequest(request, csrf);
    const account = await this.resolveAccount(sessionToken);
    if (!account) throw new InvalidGrantError('Sign in with your own Premium or administrator account.');
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
    // Binding the code to the approving browser session rechecks access then.
    await this.store.put('code', code, { ...pending, sessionToken, userId: account.id,
      audience: account.audience, scopes: scopesForAudience(account.audience) }, 120);
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
    const audience = grantAudience(pending);
    const account = await this.resolveAccount(pending.sessionToken);
    if (!accountSatisfies(account, audience) || account.id !== pending.userId)
      throw new InvalidGrantError('Your Men of Hunger session is no longer valid.');
    if (!(await this.store.get('code', code, true))) throw new InvalidGrantError('Authorization code was already used.');
    const session = await this.createSession(account.id);
    const grantId = opaque();
    const grant = { audience, scopes: pending.scopes ?? scopesForAudience(audience), clientId: client.client_id,
      userId: account.id, sessionToken: session.token, resourceUrl: this.resourceUrl,
      expiresAt: Math.min(Date.now() / 1000 + 30 * DAY, Date.parse(session.expiresAt) / 1000) };
    try {
      await this.store.put('grant', grantId, grant, grant.expiresAt - Date.now() / 1000);
      await recordConnection(this.store.redis, account.id, digest(grantId), { clientName: pending.clientName, audience });
      return await this.issueTokens(grantId, grant);
    } catch (error) {
      await this.revokeSession(session.token);
      throw error;
    }
  }
  async grantFor(grantId) {
    const grant = await this.store.get('grant', grantId);
    if (!grant || grant.resourceUrl !== this.resourceUrl || grant.expiresAt <= Date.now() / 1000) throw new InvalidGrantError('Connection expired. Reconnect in your MCP client.');
    const account = await this.resolveAccount(grant.sessionToken);
    if (!accountSatisfies(account, grantAudience(grant)) || account.id !== grant.userId)
      throw new InvalidGrantError(grantAudience(grant) === 'member'
        ? 'Premium access ended. Renew Premium, then reconnect.'
        : 'Administrator access was revoked.');
    return grant;
  }
  async issueTokens(grantId, grant) {
    const access = opaque();
    const refresh = opaque();
    const ttl = Math.min(900, Math.floor(grant.expiresAt - Date.now() / 1000));
    await this.store.put('access', access, { grantId, expiresAt: Math.floor(Date.now() / 1000) + ttl }, ttl);
    await this.store.put('refresh', refresh, { grantId, clientId: grant.clientId }, grant.expiresAt - Date.now() / 1000);
    return { access_token: access, token_type: 'Bearer', expires_in: ttl, refresh_token: refresh, scope: (grant.scopes ?? [READ_SCOPE]).join(' ') };
  }
  async exchangeRefreshToken(client, token, scopes, resource) {
    this.checkResource(resource);
    this.checkScopes(scopes);
    const refresh = await this.store.get('refresh', token);
    if (!refresh || refresh.clientId !== client.client_id) throw new InvalidGrantError('Invalid refresh token.');
    const grant = await this.grantFor(refresh.grantId);
    if (scopes?.some(scope => !(grant.scopes ?? [READ_SCOPE]).includes(scope))) throw new InvalidScopeError('Reconnect to request additional permissions.');
    if (!(await this.store.get('refresh', token, true))) throw new InvalidGrantError('Refresh token was already used.');
    if (scopes?.length) {
      // Narrowing keeps the audience's base read scope; it never crosses audiences.
      const base = scopesForAudience(grantAudience(grant))[0];
      grant.scopes = [...new Set([base, ...scopes])];
      await this.store.put('grant', refresh.grantId, grant, grant.expiresAt - Date.now() / 1000);
    }
    return this.issueTokens(refresh.grantId, grant);
  }
  async verifyAccessToken(token) {
    const access = await this.store.get('access', token);
    if (!access) throw new InvalidTokenError('Invalid or expired MCP token.');
    let grant;
    try { grant = await this.grantFor(access.grantId); }
    catch (error) {
      if (error instanceof InvalidGrantError) throw new InvalidTokenError('Connection expired or access was revoked.');
      throw error;
    }
    await touchConnection(this.store.redis, grant.userId, digest(access.grantId));
    return { token, clientId: grant.clientId, scopes: grant.scopes ?? [READ_SCOPE], expiresAt: access.expiresAt,
      resource: new URL(this.resourceUrl),
      extra: { sessionToken: grant.sessionToken, userId: grant.userId, audience: grantAudience(grant) } };
  }
  async revokeToken(client, { token }) {
    const record = await this.store.get('refresh', token) || await this.store.get('access', token);
    if (!record) return;
    const grant = await this.store.get('grant', record.grantId);
    if (!grant || grant.resourceUrl !== this.resourceUrl || grant.clientId !== client.client_id) return;
    await this.store.remove('grant', record.grantId);
    await forgetConnection(this.store.redis, grant.userId, digest(record.grantId));
    await this.revokeSession(grant.sessionToken);
  }
}

/** List and revoke a person's hosted connections from product settings and admin screens. */
export function connectionManager({ redis, secret, resourceUrl, revokeSession }) {
  const store = new OAuthStore(redis, secret);
  return {
    list: (userId) => listConnections(store, userId, resourceUrl),
    revoke: (userId, connectionId) => revokeConnection(store, { userId, connectionId, resourceUrl, revokeSession }),
  };
}
