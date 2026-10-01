/** Node 24: MOH_ISSUER=... CLIENT_ID=... CLIENT_SECRET=... CALLBACK_URL=... WEBHOOK_SECRET=... node examples/partner/client.mts */
import * as oidc from 'openid-client';
import { createServer } from 'node:http';
import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';

const required = (name: string) => { const value = process.env[name]; if (!value) throw new Error(`Set ${name}`); return value; };
const issuer = new URL(required('MOH_ISSUER'));
const redirect = new URL(required('CALLBACK_URL'));
const clientId = required('CLIENT_ID');
const secret = required('CLIENT_SECRET');
const webhookSecret = required('WEBHOOK_SECRET');
const resource = `${issuer.origin}/v1/partner`;
const config = await oidc.discovery(issuer, clientId, undefined, oidc.ClientSecretBasic(secret));
// Validate signed ID tokens against the issuer's JWKS, in addition to standard code-flow checks.
oidc.enableNonRepudiationChecks(config);
type Tokens = Awaited<ReturnType<typeof oidc.authorizationCodeGrant>>;
type Session = { state: string; nonce: string; verifier: string; expiresAt: number; tokens?: Tokens; refresh?: Promise<Tokens> };
const sessions = new Map<string, Session>();
const seenEvents = new Set<string>();
const versions = new Map<string, bigint>();
// This runnable example has one process. Production: encrypted shared session storage,
// a distributed per-grant refresh lock and durable webhook inbox, not these Maps.
async function refresh(session: Session) {
  if (session.refresh) return session.refresh;
  if (!session.tokens?.refresh_token) throw new Error('Reconnect with offline_access');
  session.refresh = oidc.refreshTokenGrant(config, session.tokens.refresh_token, { resource })
    .then(tokens => { session.tokens = tokens; return tokens; })
    .finally(() => { session.refresh = undefined; });
  return session.refresh;
}
async function read(session: Session, path: string) {
  if (!session.tokens) throw new Error('Connect first');
  if ((session.tokens.expiresIn() ?? 0) < 30) await refresh(session);
  const response = await fetch(`${resource}${path}`, { headers: { Authorization: `Bearer ${session.tokens!.access_token}` }, redirect: 'error' });
  if (!response.ok) throw new Error(`MOH ${response.status}; Retry-After=${response.headers.get('retry-after') ?? 'none'}`);
  return response.json();
}
const server = createServer(async (req, res) => {
  res.setHeader('Cache-Control', 'no-store'); res.setHeader('Referrer-Policy', 'no-referrer');
  const url = new URL(req.url ?? '/', redirect.origin);
  try {
    if (req.method === 'POST' && url.pathname === '/webhook') {
      const chunks: Buffer[] = []; let size = 0;
      for await (const chunk of req) { size += chunk.length; if (size > 1_000_000) throw new Error('Body too large'); chunks.push(chunk); }
      const raw = Buffer.concat(chunks);
      const signature = String(req.headers['x-moh-signature'] ?? '');
      const fields = signature.split(',');
      const timestamp = fields.find(v => v.startsWith('t='))?.slice(2) ?? '';
      if (!/^\d+$/.test(timestamp) || Math.abs(Date.now() / 1000 - Number(timestamp)) > 300) throw new Error('Stale signature');
      const expected = createHmac('sha256', webhookSecret).update(`${timestamp}.`).update(raw).digest();
      if (!fields.some(v => /^v1=[a-f0-9]{64}$/.test(v) && timingSafeEqual(expected, Buffer.from(v.slice(3), 'hex')))) throw new Error('Invalid signature');
      const event = JSON.parse(raw.toString('utf8'));
      if (event.id !== req.headers['x-moh-event-id'] || event.origin !== 'menofhunger') throw new Error('Invalid event');
      if (!seenEvents.has(event.id)) {
        const key = `${event.accountId}:${event.resource.kind}:${event.resource.id}`;
        const version = BigInt(event.version);
        if (version > (versions.get(key) ?? -1n)) {
          // Update your cache or apply a removal tombstone. NEVER publish a remote copy here.
          versions.set(key, version);
        }
        seenEvents.add(event.id);
      }
      res.writeHead(204).end(); return;
    }
    const sessionId = /(?:^|;\s*)moh_example=([a-zA-Z0-9_-]+)/.exec(req.headers.cookie ?? '')?.[1];
    let session = sessionId ? sessions.get(sessionId) : undefined;
    if (session && session.expiresAt < Date.now()) session = undefined;
    if (req.method === 'GET' && url.pathname === '/connect') {
      const id = randomBytes(32).toString('base64url');
      const verifier = oidc.randomPKCECodeVerifier();
      session = { state: oidc.randomState(), nonce: oidc.randomNonce(), verifier, expiresAt: Date.now() + 600_000 };
      sessions.set(id, session);
      res.setHeader('Set-Cookie', `moh_example=${id}; HttpOnly; Secure; SameSite=Lax; Path=/; Max-Age=600`);
      const target = oidc.buildAuthorizationUrl(config, { redirect_uri: redirect.href, response_type: 'code',
        scope: 'openid profile offline_access account:read content:read webhooks:read', prompt: 'consent',
        state: session.state, nonce: session.nonce, code_challenge: await oidc.calculatePKCECodeChallenge(verifier), code_challenge_method: 'S256' });
      res.writeHead(303, { Location: target.href }).end(); return;
    }
    if (req.method === 'GET' && url.pathname === redirect.pathname) {
      if (!session) throw new Error('Expired authorization; start again explicitly');
      // The library validates state even for denial, PKCE, nonce, issuer/audience and expiry.
      session.tokens = await oidc.authorizationCodeGrant(config, url, { expectedState: session.state, expectedNonce: session.nonce, pkceCodeVerifier: session.verifier }, { resource });
      session.state = ''; session.verifier = ''; session.nonce = '';
      session.expiresAt = Date.now() + 86400_000;
      res.setHeader('Set-Cookie', `moh_example=${sessionId}; HttpOnly; Secure; SameSite=Lax; Path=/; Max-Age=86400`);
      res.writeHead(303, { Location: '/' }).end(); return;
    }
    if (!session?.tokens) { res.setHeader('Content-Type', 'text/html'); res.end('<a href="/connect">Connect to Men of Hunger</a>'); return; }
    if (req.method === 'POST' && url.pathname === '/revoke') {
      // Browser POST is protected by an exact same-origin check.
      if (req.headers.origin !== redirect.origin) throw new Error('Invalid origin');
      await oidc.tokenRevocation(config, session.tokens.refresh_token ?? session.tokens.access_token);
      sessions.delete(sessionId!); res.writeHead(303, { Location: '/' }).end(); return;
    }
    const me = await read(session, '/me') as { data: { username: string } };
    const posts = await read(session, `/users/${encodeURIComponent(me.data.username)}/posts?limit=1`) as { data: { id: string }[] };
    const post = posts.data[0] ? await read(session, `/posts/${encodeURIComponent(posts.data[0].id)}`) : null;
    res.setHeader('Content-Type', 'application/json'); res.end(JSON.stringify({ me, post }));
  } catch {
    // No tokens, codes, secrets, query strings or provider error bodies in logs.
    res.writeHead(400, { 'Content-Type': 'text/plain' }).end('Connection failed or was declined. Start again explicitly at /connect.');
  }
});
server.listen(Number(process.env.PORT ?? 8787), '127.0.0.1', () => console.log('Partner example listening on loopback; use your registered HTTPS reverse proxy.'));
