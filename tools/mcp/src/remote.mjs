import express from 'express';
import { rateLimit } from 'express-rate-limit';
import { mcpAuthRouter } from '@modelcontextprotocol/sdk/server/auth/router.js';
import { requireBearerAuth } from '@modelcontextprotocol/sdk/server/auth/middleware/bearerAuth.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { createServer } from './server.mjs';
import { MohApi, normalizeBaseUrl } from './api.mjs';
import { MohOAuthProvider, OAuthStore, READ_SCOPE } from './oauth.mjs';

const escapeHtml = (value) => String(value).replace(/[&<>"']/g, (ch) => ({
  '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
})[ch]);

function page(res, title, content) {
  res.setHeader('Content-Security-Policy', "default-src 'none'; style-src 'unsafe-inline'; form-action 'self'; frame-ancestors 'none'; base-uri 'none'");
  res.setHeader('Referrer-Policy', 'no-referrer');
  res.type('html').send(`<!doctype html><html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${escapeHtml(title)} · Men of Hunger</title><style>body{font:18px/1.6 system-ui;margin:10vh auto;padding:0 24px;max-width:580px;color:#ece8e1;background:#171916}h1{line-height:1.15}p{color:#c5c9bd}a{color:#d7ec97}button{font:inherit;cursor:pointer;border:0;border-radius:8px;padding:12px 18px;margin:8px 8px 0 0;background:#d7ec97;color:#171916}button[value=deny]{background:#363b31;color:#ece8e1}small{color:#a8af9e}</style><main><small>MEN OF HUNGER</small><h1>${escapeHtml(title)}</h1>${content}</main></html>`);
}

// Mount at the API root before the cookie-auth CSRF middleware. Only these exact
// protocol paths bypass it; consent has its own strict Origin + double-submit check.
export function createRemoteMcp({ redis, secret, baseUrl, frontendUrl, resolveAdmin,
  createSession, revokeSession, sessionCookie, fetchImpl = fetch }) {
  baseUrl = normalizeBaseUrl(baseUrl);
  const origin = new URL(baseUrl).origin;
  const resourceUrl = `${origin}/mcp`;
  const provider = new MohOAuthProvider({ store: new OAuthStore(redis, secret),
    resourceUrl, resolveAdmin, createSession, revokeSession });
  const router = express.Router();
  const paths = new Set(['/mcp', '/mcp/consent', '/authorize', '/token', '/register', '/revoke',
    '/.well-known/oauth-authorization-server', '/.well-known/oauth-protected-resource/mcp']);
  router.use((_req, res, next) => { res.setHeader('Cache-Control', 'no-store'); next(); });
  router.use(express.json({ limit: '128kb' }));
  router.use(express.urlencoded({ extended: false, limit: '16kb' }));
  router.use(mcpAuthRouter({ provider, issuerUrl: new URL(origin), resourceServerUrl: new URL(resourceUrl),
    scopesSupported: [READ_SCOPE], resourceName: 'Men of Hunger',
    // Keep registration valid as long as its encrypted client record (90 days).
    clientRegistrationOptions: { clientSecretExpirySeconds: 90 * 86400 },
  }));

  router.all('/mcp/consent', rateLimit({ windowMs: 60_000, limit: 30, legacyHeaders: false }), async (req, res) => {
    try {
      const request = req.method === 'POST' ? req.body?.request : req.query.request;
      const csrf = req.cookies?.moh_mcp_consent;
      const pending = await provider.consentRequest(request, csrf);
      if (req.method === 'POST') {
        if (req.headers.origin !== origin || typeof req.body?.csrf !== 'string' ||
          req.body.csrf !== csrf || !['allow', 'deny'].includes(req.body?.decision)) {
          res.status(403); return page(res, 'Connection blocked', '<p>Start again from ChatGPT.</p>');
        }
        const callback = await provider.consent(request, csrf, sessionCookie(req), req.body.decision === 'allow');
        res.clearCookie('moh_mcp_consent', { path: '/mcp/consent' });
        return res.redirect(303, callback);
      }
      if (req.method !== 'GET') return res.status(405).end();
      const admin = await resolveAdmin(sessionCookie(req));
      if (!admin) {
        return page(res, 'Sign in to connect', `<p>Sign in to Men of Hunger with your own site administrator account, then return to this tab.</p><p><a href="${escapeHtml(frontendUrl)}" target="_blank" rel="noopener noreferrer">Open Men of Hunger</a></p><p><a href="/mcp/consent?request=${escapeHtml(request)}">I’m signed in — continue</a></p>`);
      }
      return page(res, 'Connect Men of Hunger', `<p>${escapeHtml(pending.clientName)} is requesting read access as <strong>@${escapeHtml(admin.username || admin.id)}</strong>.</p><p>Access includes company analytics, member account diagnostics, support and moderation queues, public posts, and newsletters. Support content may contain personal information.</p><p>This connection cannot publish, send messages, change memberships, or take moderation actions. You can disconnect it in ChatGPT.</p><form method="post" action="/mcp/consent"><input type="hidden" name="request" value="${escapeHtml(request)}"><input type="hidden" name="csrf" value="${escapeHtml(csrf)}"><button name="decision" value="allow">Allow read access</button><button name="decision" value="deny">Cancel</button></form><p><small>Environment: ${escapeHtml(baseUrl)}</small></p>`);
    } catch {
      res.status(400); page(res, 'Reconnect from ChatGPT', '<p>This connection request expired or your administrator sign-in could not be verified. Start again from ChatGPT.</p>');
    }
  });

  router.all('/mcp', rateLimit({ windowMs: 60_000, limit: 120, legacyHeaders: false }),
    requireBearerAuth({ verifier: provider, requiredScopes: [READ_SCOPE],
      resourceMetadataUrl: `${origin}/.well-known/oauth-protected-resource/mcp` }),
    async (req, res) => {
      if (req.headers.origin && req.headers.origin !== origin && req.headers.origin !== 'https://chatgpt.com')
        return res.status(403).json({ error: 'invalid_origin' });
      if (req.method !== 'POST') return res.status(405).setHeader('Allow', 'POST').end();
      // A request-bound session never touches local credentials or files. The
      // canonical admin guards still authorize every underlying API read.
      const store = {
        credentialName: () => 'remote',
        read: async () => ({ baseUrl, token: req.auth.extra.sessionToken,
          expiresAt: new Date(req.auth.expiresAt * 1000).toISOString() }),
        write: async () => {},
      };
      const api = new MohApi({ baseUrl, store, fetchImpl });
      const server = createServer({ api, store, localArtifacts: false });
      const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
      res.on('close', () => { void server.close().catch(() => {}); });
      try {
        await server.connect(transport);
        await transport.handleRequest(req, res, req.body);
      } catch {
        if (!res.headersSent) res.status(500).json({ error: 'mcp_unavailable' });
      }
    });
  router.use((_error, _req, res, _next) => {
    if (!res.headersSent) res.status(500).json({ error: 'mcp_unavailable' });
  });
  return (req, res, next) => paths.has(req.path) ? router(req, res, next) : next();
}
