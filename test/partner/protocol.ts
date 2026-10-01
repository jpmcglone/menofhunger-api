/** Hermetic protocol test: real oidc-provider, synthetic storage and no external providers. */
import 'reflect-metadata';
import assert = require('node:assert/strict');
import { generateKeyPairSync, createHash } from 'node:crypto';
import express = require('express');
import request = require('supertest');
import { sealSecret } from '../../src/common/crypto/secret-box';
import { PartnerOAuthService } from '../../src/modules/partner/partner-oauth.service';
import { PartnerAccessService } from '../../src/modules/partner/partner-access.service';

async function main() {
  const encryptionKey = 'synthetic-partner-test-key-at-least-32-characters';
  const records = new Map<string, any>(), grants = new Map<string, any>(), cache = new Map<string, string>();
  const human = { id: 'human', username: 'synthetic', name: 'Synthetic Member', accountKind: 'person', bannedAt: null, createdAt: new Date(), usernameIsSet: false, birthdate: new Date('1990-01-01'), interests: ['health'], menOnlyConfirmed: true };
  const client = { id: 'fixture', name: 'Fixture', active: true, clientReadLimit: 1200, accountReadLimit: 120, secretEnc: sealSecret('synthetic-secret', encryptionKey),
    redirectUris: ['https://client.example/callback'], logoutRedirectUris: [], scopes: ['openid', 'profile', 'offline_access', 'account:read', 'content:read'] };
  const matches = (row: any, where: any) => Object.entries(where).every(([key, value]) => row[key] === value);
  const prisma: any = {
    partnerClient: { findUnique: async ({ where }: any) => where.id === client.id ? client : where.id === 'other-fixture' ? { ...client, id: 'other-fixture' } : null },
    user: { findUnique: async () => human, findMany: async () => [human] },
    userPageOperator: { findMany: async () => [] },
    partnerGrant: {
      findUnique: async ({ where }: any) => grants.get(where.id),
      create: async ({ data }: any) => { grants.set(data.id, { ...data, revokedAt: null }); return data; },
      updateMany: async ({ where, data }: any) => { let count = 0; for (const row of grants.values()) if (matches(row, where)) { Object.assign(row, data); count++; } return { count }; },
    },
    partnerOidcRecord: {
      findUnique: async ({ where }: any) => records.get(where.key),
      findFirst: async ({ where }: any) => [...records.values()].find(row => matches(row, where)),
      upsert: async ({ where, create, update }: any) => { const row = records.has(where.key) ? { ...records.get(where.key), ...update } : { consumedAt: null, ...create }; records.set(where.key, row); return row; },
      updateMany: async ({ where, data }: any) => { let count = 0; for (const row of records.values()) if (matches(row, where)) { Object.assign(row, data); count++; } return { count }; },
      deleteMany: async ({ where }: any) => { for (const [key, row] of records) if (matches(row, where)) records.delete(key); },
    },
    $transaction: async (operations: any[]) => Promise.all(operations),
  };
  const redis: any = { getString: async (key: string) => cache.get(key), setString: async (key: string, value: string, options: any) => {
    if (options?.onlyIfAbsent && cache.has(key)) return false; cache.set(key, value); return true;
  }, raw: () => ({ del: async (key: string) => cache.delete(key), eval: async (_: string, _n: number, key: string, value: string) => { if (cache.get(key) === value) cache.delete(key); return 1; } }) };
  const privateKey = generateKeyPairSync('rsa', { modulusLength: 2048 }).privateKey.export({ format: 'jwk' });
  const retiringKey = generateKeyPairSync('rsa', { modulusLength: 2048 }).privateKey.export({ format: 'jwk' });
  const app = express(); app.use(express.urlencoded({ extended: false }));
  const server = app.listen(0, '127.0.0.1');
  await new Promise<void>(resolve => server.once('listening', resolve));
  const port = (server.address() as { port: number }).port;
  const issuer = `http://127.0.0.1:${port}/oauth`;
  const cfg: any = { partner: () => ({ enabled: true, encryptionKey, jwks: JSON.stringify({ keys: [{ ...privateKey, kid: 'fixture', use: 'sig', alg: 'RS256' }, { ...retiringKey, kid: 'retiring', use: 'sig', alg: 'RS256' }] }), issuer }), trustProxy: () => false, frontendBaseUrl: () => 'https://menofhunger.example' };
  const access = new PartnerAccessService(prisma);
  let signedIn = false;
  const rateChecks: Array<Array<{ key: string; limit: number }>> = [];
  const analytics: Array<{ id: string; event: string; properties: unknown }> = [];
  const oauth = new PartnerOAuthService(cfg, prisma, { meFromSessionToken: async () => signedIn ? ({ user: human }) : null } as any, redis, access, { check: async (buckets: Array<{ key: string; limit: number }>) => { rateChecks.push(buckets); } } as any, { capture: (id: string, event: string, properties: unknown) => analytics.push({ id, event, properties }) } as any);
  app.use(oauth.middleware());
  try {
    const agent = request.agent(server);
    const discovery = await agent.get('/oauth/.well-known/openid-configuration');
    assert.equal(discovery.status, 200, JSON.stringify(discovery.body));
    assert.equal(discovery.body.issuer, issuer);
    assert.equal(discovery.body.token_endpoint, `${issuer}/token`);
    assert.deepEqual(discovery.body.code_challenge_methods_supported, ['S256']);
    const jwks = await agent.get('/oauth/jwks');
    assert.equal(jwks.body.keys.length, 2); assert.ok(jwks.body.keys.every((key: any) => !key.d && !key.p && !key.q));
    await assert.rejects(() => oauth.tokenPrincipal('first-party-or-mcp-token'));
    const verifier = 'v'.repeat(43), nonce = 'synthetic-nonce';
    const params = { client_id: client.id, redirect_uri: client.redirectUris[0], response_type: 'code', prompt: 'consent', scope: client.scopes.join(' '), state: 'synthetic-state', nonce, code_challenge: createHash('sha256').update(verifier).digest('base64url'), code_challenge_method: 'S256' };
    const invalidRedirect = await agent.get('/oauth/authorize').query({ ...params, redirect_uri: 'https://attacker.example/callback' });
    assert.equal(invalidRedirect.status, 400); assert.equal(invalidRedirect.headers.location, undefined);
    const missingState = await agent.get('/oauth/authorize').query({ ...params, state: undefined });
    assert.equal(missingState.status, 400);
    const missingNonce = await agent.get('/oauth/authorize').query({ ...params, nonce: undefined });
    assert.equal(missingNonce.status, 400);
    const begin = await agent.get('/oauth/authorize').query(params);
    assert.equal(begin.status, 303, begin.text);
    const local = (url: string) => new URL(url, issuer).pathname + new URL(url, issuer).search;
    const signup = await agent.get(local(begin.headers.location));
    assert.equal(signup.status, 200); assert.ok(signup.text.includes('https://menofhunger.example/login?redirect='));
    human.createdAt = new Date(); signedIn = true;
    const setup = await agent.get(local(begin.headers.location));
    assert.equal(setup.status, 200); assert.ok(setup.text.includes('Finish account setup'));
    assert.ok(setup.text.includes('/connect/partner?interaction='));
    human.usernameIsSet = true;
    let consent = await agent.get(local(begin.headers.location));
    assert.equal(consent.status, 200, consent.text);
    consent = await agent.get(local(begin.headers.location));
    assert.equal(analytics.filter(e => e.event === 'partner_connection_started').length, 1);
    assert.equal(analytics.filter(e => e.event === 'partner_connection_authenticated').length, 1);
    assert.equal(analytics.filter(e => e.event === 'partner_attributed_signup').length, 1);
    assert.ok(!JSON.stringify(analytics).includes('synthetic-secret'));
    const csrf = /name="csrf" value="([^"]+)"/.exec(consent.text)?.[1]; assert.ok(csrf);
    const approved = await agent.post(local(begin.headers.location)).type('form').send({ csrf, accountId: human.id, decision: 'allow', scope: ['profile', 'content:read'] });
    assert.equal(approved.status, 303, approved.text);
    const completed = await agent.get(local(approved.headers.location));
    assert.equal(completed.status, 303, completed.text);
    const callback = new URL(completed.headers.location); assert.equal(callback.searchParams.get('state'), params.state);
    const code = callback.searchParams.get('code'); assert.ok(code, callback.href);
    const exchange = (values: object) => agent.post('/oauth/token').auth(client.id, 'synthetic-secret').type('form').send(values);
    const badPkce = await exchange({ grant_type: 'authorization_code', code, redirect_uri: client.redirectUris[0], resource: `http://127.0.0.1:${port}/v1/partner`, code_verifier: 'z'.repeat(43) });
    assert.equal(badPkce.status, 400);
    const oidc = require('openid-client');
    const configuration = await oidc.discovery(new URL(issuer), client.id, undefined, oidc.ClientSecretBasic('synthetic-secret'), { execute: [oidc.allowInsecureRequests] });
    oidc.enableNonRepudiationChecks(configuration);
    const bodyFromClient = await oidc.authorizationCodeGrant(configuration, callback, { expectedState: params.state, expectedNonce: nonce, pkceCodeVerifier: verifier }, { resource: `http://127.0.0.1:${port}/v1/partner` });
    const token = { body: bodyFromClient };
    assert.ok(token.body.refresh_token); assert.ok(token.body.id_token);
    assert.equal(token.body.expires_in, 900);
    const claims = JSON.parse(Buffer.from(token.body.id_token.split('.')[1], 'base64url').toString());
    assert.equal(claims.sub, human.id); assert.equal(claims.nonce, nonce);
    const principal = await oauth.tokenPrincipal(token.body.access_token);
    assert.equal(principal.grant.userId, human.id); assert.ok(principal.scopes.includes('content:read'));
    const body = { grant_type: 'refresh_token', refresh_token: token.body.refresh_token, resource: `http://127.0.0.1:${port}/v1/partner` };
    const racedRefreshes = await Promise.all([exchange(body), exchange(body)]);
    const refresh = racedRefreshes.find(response => response.status === 200)!;
    assert.ok(refresh, JSON.stringify(racedRefreshes.map(r => r.body)));
    assert.ok(racedRefreshes.every(response => [200, 429].includes(response.status)));
    for (const response of racedRefreshes.filter(r => r.status === 429)) assert.equal(response.headers['retry-after'], '1');
    const replay = await exchange(body); assert.equal(replay.status, 200, replay.text); assert.deepEqual(replay.body, refresh.body);
    const userinfoTokens = await exchange({ grant_type: 'refresh_token', refresh_token: refresh.body.refresh_token });
    assert.equal(userinfoTokens.status, 200, userinfoTokens.text);
    const userinfo = await agent.get('/oauth/userinfo').auth(userinfoTokens.body.access_token, { type: 'bearer' });
    assert.equal(userinfo.status, 200, userinfo.text); assert.equal(userinfo.body.sub, human.id);
    assert.ok(rateChecks.at(-1)?.some(bucket => bucket.key === `account:${client.id}:${human.id}`));
    const introspection = await agent.post('/oauth/introspect').auth(client.id, 'synthetic-secret').type('form').send({ token: userinfoTokens.body.access_token });
    assert.equal(introspection.status, 200); assert.equal(introspection.body.active, true);
    assert.equal(rateChecks.at(-1)?.[0].key, `oauth-control:${client.id}`);
    const otherInspection = await agent.post('/oauth/introspect').auth('other-fixture', 'synthetic-secret').type('form').send({ token: userinfoTokens.body.access_token });
    assert.deepEqual(otherInspection.body, { active: false });
    await agent.post('/oauth/revoke').auth('other-fixture', 'synthetic-secret').type('form').send({ token: userinfoTokens.body.access_token });
    const stillActive = await agent.post('/oauth/introspect').auth(client.id, 'synthetic-secret').type('form').send({ token: userinfoTokens.body.access_token });
    assert.equal(stillActive.body.active, true);

    await assert.rejects(() => oauth.tokenPrincipal(userinfoTokens.body.access_token));
    for (const key of cache.keys()) if (key.includes('refresh:result:')) cache.delete(key);
    const reused = await exchange(body); assert.equal(reused.status, 400, reused.text);
    await assert.rejects(() => oauth.tokenPrincipal(refresh.body.access_token));
    const deniedStart = await agent.get('/oauth/authorize').query({ ...params, state: 'denial-state' });
    const deniedConsent = await agent.get(local(deniedStart.headers.location));
    const deniedCsrf = /name="csrf" value="([^"]+)"/.exec(deniedConsent.text)?.[1]; assert.ok(deniedCsrf);
    const denied = await agent.post(local(deniedStart.headers.location)).type('form').send({ csrf: deniedCsrf, accountId: human.id, decision: 'deny' });
    assert.equal(denied.status, 303);
    const deniedCompleted = await agent.get(local(denied.headers.location));
    assert.equal(deniedCompleted.status, 303);
    const deniedReturn = new URL(deniedCompleted.headers.location);
    assert.equal(deniedReturn.origin, 'https://client.example');
    assert.equal(deniedReturn.searchParams.get('error'), 'access_denied');
    assert.equal(deniedReturn.searchParams.get('state'), 'denial-state');
    console.log('Partner protocol: discovery, PKCE rejection, consent, code exchange, ID token nonce, resource token, refresh replay and family revocation passed.');
  } finally { await new Promise<void>((resolve, reject) => server.close(err => err ? reject(err) : resolve())); }
}
void main().catch(e => { console.error(e); process.exitCode = 1; });
