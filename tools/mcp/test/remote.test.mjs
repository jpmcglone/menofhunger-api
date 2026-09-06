import test from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import { once } from 'node:events';
import { createHash, randomBytes } from 'node:crypto';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { createRemoteMcp } from '../src/remote.mjs';
import { OAuthStore, MohOAuthProvider } from '../src/oauth.mjs';

class TestRedis {
  values = new Map();
  async set(key, value, _ex, ttl) { this.values.set(key, { value, expires: Date.now() + ttl * 1000 }); }
  async get(key) {
    const row = this.values.get(key);
    return row?.expires > Date.now() ? row.value : null;
  }
  async getdel(key) { const value = await this.get(key); this.values.delete(key); return value; }
  async del(key) { this.values.delete(key); }
}

const callback = 'https://chatgpt.com/connector/oauth/test_callback';
async function fixture(t) {
  const app = express();
  const http = app.listen(0, '127.0.0.1');
  await once(http, 'listening');
  t.after(() => { http.closeAllConnections(); http.close(); });
  const origin = `http://127.0.0.1:${http.address().port}`;
  const redis = new TestRedis();
  const sessions = new Set(['browser-admin']);
  let adminEnabled = true;
  let created = 0;
  app.use((req, _res, next) => {
    req.cookies = Object.fromEntries((req.headers.cookie || '').split(';').map((part) => {
      const i = part.indexOf('='); return [part.slice(0, i).trim(), part.slice(i + 1)];
    })); next();
  });
  app.use(createRemoteMcp({ redis, secret: 'test-encryption-key', baseUrl: `${origin}/v1`,
    frontendUrl: 'https://menofhunger.com',
    resolveAdmin: async (token) => adminEnabled && sessions.has(token) ? { id: 'founder', username: '<founder>' } : null,
    createSession: async () => {
      const token = `dedicated-${++created}`; sessions.add(token);
      return { token, expiresAt: new Date(Date.now() + 30 * 86400_000).toISOString() };
    },
    revokeSession: async (token) => { sessions.delete(token); },
    sessionCookie: (req) => req.cookies.moh_session,
  }));
  const apiReads = [];
  app.get('/v1/admin/feedback', (req, res) => {
    apiReads.push(req.headers.cookie);
    if (!sessions.has(req.cookies.moh_session)) return res.status(404).json({ data: null });
    res.json({ data: [{ id: 'f1', subject: 'Test feedback', email: 'secret@example.com' }], pagination: { nextCursor: null } });
  });
  app.post('/ordinary-cookie-route', (_req, res) => res.status(403).json({ error: 'csrf' }));
  const request = (path, init = {}) => fetch(`${origin}${path}`, { ...init, redirect: 'manual' });
  const post = (path, body, init = {}) => request(path, { ...init, method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded', ...init.headers }, body: new URLSearchParams(body) });
  const register = async (metadata = {}) => {
    const response = await request('/register', { method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ redirect_uris: [callback], client_name: 'ChatGPT', scope: 'moh:read',
        token_endpoint_auth_method: 'client_secret_post', ...metadata }) });
    return { response, client: await response.json() };
  };
  const authorize = async (client, extra = {}) => {
    const verifier = randomBytes(32).toString('base64url');
    const params = new URLSearchParams({ client_id: client.client_id, redirect_uri: callback,
      response_type: 'code', code_challenge_method: 'S256',
      code_challenge: createHash('sha256').update(verifier).digest('base64url'),
      scope: 'moh:read', state: 'keep-this-state', resource: `${origin}/mcp`, ...extra });
    const response = await request(`/authorize?${params}`);
    const cookie = response.headers.get('set-cookie')?.split(';')[0];
    return { response, cookie, verifier, path: response.headers.get('location') };
  };
  const approve = async (auth, options = {}) => {
    const id = new URL(auth.path, origin).searchParams.get('request');
    return post('/mcp/consent', { request: id, csrf: auth.cookie.split('=')[1], decision: 'allow', ...options.body }, {
      headers: { Origin: origin, Cookie: `${auth.cookie}; moh_session=browser-admin`, ...options.headers },
    });
  };
  const exchange = (client, code, verifier, extra = {}) => post('/token', {
    client_id: client.client_id, client_secret: client.client_secret, grant_type: 'authorization_code',
    code, code_verifier: verifier, redirect_uri: callback, resource: `${origin}/mcp`, ...extra,
  });
  const connect = async () => {
    const { client } = await register();
    const auth = await authorize(client);
    const allowed = await approve(auth);
    assert.equal(allowed.status, 303);
    const redirect = new URL(allowed.headers.get('location'));
    assert.equal(redirect.searchParams.get('state'), 'keep-this-state');
    const code = redirect.searchParams.get('code');
    const response = await exchange(client, code, auth.verifier);
    assert.equal(response.status, 200);
    return { client, auth, code, tokens: await response.json() };
  };
  return { origin, redis, sessions, apiReads, request, post, register, authorize, approve, exchange, connect,
    disableAdmin: () => { adminEnabled = false; }, createdSessions: () => created };
}

test('OAuth discovery challenges anonymous callers; protocol handling stays on exact paths', async (t) => {
  const f = await fixture(t);
  const missing = await f.post('/mcp', {});
  assert.equal(missing.status, 401);
  assert.match(missing.headers.get('www-authenticate'), /oauth-protected-resource\/mcp/);
  const resource = await (await f.request('/.well-known/oauth-protected-resource/mcp')).json();
  assert.equal(resource.resource, `${f.origin}/mcp`);
  const issuer = await (await f.request('/.well-known/oauth-authorization-server')).json();
  assert.deepEqual(issuer.code_challenge_methods_supported, ['S256']);
  assert.equal(issuer.token_endpoint, `${f.origin}/token`);
  assert.equal((await f.post('/ordinary-cookie-route', {})).status, 403);
  assert.equal((await f.post('/token/unexpected', {})).status, 404);
});

test('DCR rejects arbitrary callbacks and write scopes; authorization binds its resource', async (t) => {
  const f = await fixture(t);
  for (const uri of ['https://evil.example/callback', 'https://chatgpt.com.evil.example/connector/oauth/a',
    'https://chatgpt.com/connector/oauth/a?redirect=evil']) {
    assert.equal((await f.register({ redirect_uris: [uri] })).response.status, 400);
  }
  assert.equal((await f.register({ scope: 'moh:write' })).response.status, 400);
  const { client } = await f.register();
  const auth = await f.authorize(client, { resource: 'https://evil.example/mcp' });
  assert.equal(new URL(auth.path).searchParams.get('error'), 'invalid_target');
  assert.equal(f.createdSessions(), 0);
});

test('consent requires administrator sign-in, origin and CSRF; HTML escapes member content', async (t) => {
  const f = await fixture(t);
  const { client } = await f.register();
  const auth = await f.authorize(client);
  const unsigned = await f.request(auth.path, { headers: { Cookie: auth.cookie } });
  assert.match(await unsigned.text(), /Sign in to connect/);
  const signed = await f.request(auth.path, { headers: { Cookie: `${auth.cookie}; moh_session=browser-admin` } });
  assert.match(await signed.text(), /&lt;founder&gt;/);
  assert.match(signed.headers.get('content-security-policy'), /frame-ancestors 'none'/);
  assert.equal((await f.approve(auth, { headers: { Origin: 'https://evil.example' } })).status, 403);
  assert.equal((await f.approve(auth, { body: { csrf: 'wrong' } })).status, 403);
  assert.equal((await f.approve(auth, { headers: { Cookie: `${auth.cookie}; moh_session=non-admin` } })).status, 400);
  assert.equal(f.createdSessions(), 0);
  const canceled = await f.approve(auth, { body: { decision: 'deny' } });
  assert.equal(new URL(canceled.headers.get('location')).searchParams.get('error'), 'access_denied');
  assert.equal(f.createdSessions(), 0);
});

test('authorization code enforces PKCE, redirect and one-time redemption', async (t) => {
  const f = await fixture(t);
  const { client } = await f.register();
  const auth = await f.authorize(client);
  const allowed = await f.approve(auth);
  const code = new URL(allowed.headers.get('location')).searchParams.get('code');
  assert.equal((await f.approve(auth)).status, 400);
  assert.equal((await f.exchange(client, code, 'wrong-verifier')).status, 400);
  assert.equal((await f.exchange(client, code, auth.verifier, { redirect_uri: `${callback}wrong` })).status, 400);
  assert.equal((await f.exchange(client, code, auth.verifier, { resource: 'https://evil.example/mcp' })).status, 400);
  const response = await f.exchange(client, code, auth.verifier);
  assert.equal(response.status, 200);
  assert.equal((await f.exchange(client, code, auth.verifier)).status, 400);
  assert.equal(f.createdSessions(), 1);
  const stored = JSON.stringify([...f.redis.values]);
  assert.equal(stored.includes('browser-admin'), false);
  assert.equal(stored.includes('dedicated-1'), false);
  assert.equal(stored.includes(client.client_secret), false);
});

test('hosted MCP performs real HTTP handshake and reads via the shared API tools', async (t) => {
  const f = await fixture(t);
  const { tokens } = await f.connect();
  const client = new Client({ name: 'remote-test', version: '1.0' });
  t.after(() => client.close());
  await client.connect(new StreamableHTTPClientTransport(new URL(`${f.origin}/mcp`), {
    requestInit: { headers: { Authorization: `Bearer ${tokens.access_token}` } },
  }));
  const catalog = (await client.listTools()).tools;
  assert.equal(catalog.length, 18);
  assert.ok(catalog.every((tool) => tool.annotations.readOnlyHint));
  assert.equal(catalog.some((tool) => tool.name === 'save_draft'), false);
  const result = await client.callTool({ name: 'feedback', arguments: { limit: 2 } });
  assert.equal(result.structuredContent.data[0].subject, 'Test feedback');
  assert.equal(result.structuredContent.environment, `${f.origin}/v1`);
  assert.equal(JSON.stringify(result).includes('secret@example.com'), false);
  assert.deepEqual(f.apiReads, ['moh_session=dedicated-1']);
  assert.match((await client.readResource({ uri: 'moh://guide' })).contents[0].text, /hosted connection is read-only/);
  assert.equal((await client.callTool({ name: 'save_draft', arguments: {} })).isError, true);
});

test('refresh rotates once, rejects another client and revokes the whole connection', async (t) => {
  const f = await fixture(t);
  const { client, tokens } = await f.connect();
  const other = (await f.register()).client;
  const refresh = (owner, extra = {}) => f.post('/token', { grant_type: 'refresh_token',
    client_id: owner.client_id, client_secret: owner.client_secret, refresh_token: tokens.refresh_token,
    resource: `${f.origin}/mcp`, ...extra });
  assert.equal((await refresh(other)).status, 400);
  assert.equal((await refresh(client, { scope: 'moh:write' })).status, 400);
  const rotated = await refresh(client);
  assert.equal(rotated.status, 200);
  const nextTokens = await rotated.json();
  assert.notEqual(nextTokens.refresh_token, tokens.refresh_token);
  assert.equal((await refresh(client)).status, 400);
  const revoke = await f.post('/revoke', { client_id: client.client_id, client_secret: client.client_secret,
    token: nextTokens.refresh_token, token_type_hint: 'refresh_token' });
  assert.equal(revoke.status, 200);
  assert.equal(f.sessions.has('dedicated-1'), false);
  assert.equal(f.sessions.has('browser-admin'), true);
  for (const token of [tokens.access_token, nextTokens.access_token]) {
    const response = await f.post('/mcp', {}, { headers: { Authorization: `Bearer ${token}` } });
    assert.equal(response.status, 401);
  }
});

test('removing administrator access blocks issued access and refresh tokens', async (t) => {
  const f = await fixture(t);
  const { client, tokens } = await f.connect();
  f.disableAdmin();
  assert.equal((await f.post('/mcp', {}, { headers: { Authorization: `Bearer ${tokens.access_token}` } })).status, 401);
  assert.equal((await f.post('/token', { grant_type: 'refresh_token', client_id: client.client_id,
    client_secret: client.client_secret, refresh_token: tokens.refresh_token })).status, 400);
});

test('tokens remain bound to their resource even when environments share Redis and encryption keys', async (t) => {
  const f = await fixture(t);
  const { client, tokens } = await f.connect();
  const other = new MohOAuthProvider({ store: new OAuthStore(f.redis, 'test-encryption-key'),
    resourceUrl: 'https://another-environment.example/mcp',
    resolveAdmin: async () => ({ id: 'founder' }),
    revokeSession: async () => { throw new Error('Wrong environment must not revoke this session.'); },
  });
  await assert.rejects(other.verifyAccessToken(tokens.access_token));
  await assert.rejects(other.exchangeRefreshToken(client, tokens.refresh_token));
  await other.revokeToken(client, { token: tokens.access_token });
  assert.equal(f.sessions.has('dedicated-1'), true);
});

test('encrypted OAuth state rejects tampering and cannot be substituted between keys', async () => {
  const redis = new TestRedis();
  const store = new OAuthStore(redis, 'fixture-key');
  await store.put('grant', 'a', { sessionToken: 'private' }, 60);
  redis.values.set(store.keyFor('grant', 'b'), redis.values.get(store.keyFor('grant', 'a')));
  await assert.rejects(store.get('grant', 'b'));
  assert.deepEqual(await store.get('grant', 'a', true), { sessionToken: 'private' });
  assert.equal(await store.get('grant', 'a', true), null);
});
