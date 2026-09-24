import express from 'express';
import { rateLimit } from 'express-rate-limit';
import { mcpAuthRouter } from '@modelcontextprotocol/sdk/server/auth/router.js';
import { requireBearerAuth } from '@modelcontextprotocol/sdk/server/auth/middleware/bearerAuth.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { createServer, createMemberServer } from './server.mjs';
import { MohApi, normalizeBaseUrl } from './api.mjs';
import { memberAllowance } from './allowance.mjs';
import { MohOAuthProvider, OAuthStore, READ_SCOPE, WRITE_SCOPE, MEMBER_READ_SCOPE } from './oauth.mjs';

const escapeHtml = (value) => String(value).replace(/[&<>"']/g, (ch) => ({
  '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
})[ch]);

function page(res, title, content) {
  res.setHeader('Content-Security-Policy', "default-src 'none'; style-src 'unsafe-inline'; form-action 'self'; frame-ancestors 'none'; base-uri 'none'");
  res.setHeader('Referrer-Policy', 'no-referrer');
  // Popup OAuth (Grok Bot / Cursor webview) needs the opener relationship.
  res.setHeader('Cross-Origin-Opener-Policy', 'unsafe-none');
  res.type('html').send(`<!doctype html><html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${escapeHtml(title)} · Men of Hunger</title><style>body{font:18px/1.6 system-ui;margin:10vh auto;padding:0 24px;max-width:580px;color:#ece8e1;background:#171916}h1{line-height:1.15}p{color:#c5c9bd}a{color:#d7ec97}button{font:inherit;cursor:pointer;border:0;border-radius:8px;padding:12px 18px;margin:8px 8px 0 0;background:#d7ec97;color:#171916}button[value=deny]{background:#363b31;color:#ece8e1}small{color:#a8af9e}</style><main><small>MEN OF HUNGER</small><h1>${escapeHtml(title)}</h1>${content}</main></html>`);
}

// Mount at the API root before the cookie-auth CSRF middleware. Only these exact
// protocol paths bypass it; consent has its own strict Origin + double-submit check.
export function createRemoteMcp({ redis, secret, baseUrl, frontendUrl, resolveAccount, resolveAdmin,
  createSession, revokeSession, sessionCookie, fetchImpl = fetch, memberDailyCalls = 200 }) {
  baseUrl = normalizeBaseUrl(baseUrl);
  const origin = new URL(baseUrl).origin;
  const resourceUrl = `${origin}/mcp`;
  const provider = new MohOAuthProvider({ store: new OAuthStore(redis, secret),
    resourceUrl, resolveAccount, resolveAdmin, createSession, revokeSession });
  const allowance = memberAllowance(redis, { daily: memberDailyCalls });
  const router = express.Router();
  const paths = new Set(['/mcp', '/mcp/consent', '/authorize', '/token', '/register', '/revoke',
    '/.well-known/oauth-authorization-server', '/.well-known/oauth-protected-resource/mcp']);
  router.use((_req, res, next) => { res.setHeader('Cache-Control', 'no-store'); next(); });
  router.use(express.json({ limit: '128kb' }));
  router.use(express.urlencoded({ extended: false, limit: '16kb' }));
  router.use(mcpAuthRouter({ provider, issuerUrl: new URL(origin), resourceServerUrl: new URL(resourceUrl),
    scopesSupported: [READ_SCOPE, WRITE_SCOPE, MEMBER_READ_SCOPE], resourceName: 'Men of Hunger',
    // Keep registration valid as long as its encrypted client record (90 days).
    clientRegistrationOptions: { clientSecretExpirySeconds: 90 * 86400 },
  }));

  router.all('/mcp/consent', rateLimit({ windowMs: 60_000, limit: 30, legacyHeaders: false }), async (req, res) => {
    try {
      const request = req.method === 'POST' ? req.body?.request : req.query.request;
      if (req.method === 'POST') {
        // Form CSRF is bound to the pending request in Redis. Do not also require
        // the cookie: embedded browsers drop it, or send a stale one from an
        // earlier attempt, which used to 403 every Allow click.
        const bodyCsrf = req.body?.csrf;
        const decision = req.body?.decision;
        const requestOrigin = req.headers.origin;
        // Compare to the host that served this form, not only BROWSER_HANDOFF
        // origin. Cursor/Grok in-app browsers often send their own Origin.
        const hostHeader = String(req.headers.host || '').split(',')[0].trim();
        const hostOrigin = hostHeader ? `${req.protocol}://${hostHeader}` : origin;
        const allowedOrigins = new Set([origin, hostOrigin,
          'https://chatgpt.com', 'https://www.cursor.com', 'https://cursor.com']);
        const originOk = !requestOrigin || requestOrigin === 'null' || allowedOrigins.has(requestOrigin);
        const csrfOk = typeof bodyCsrf === 'string' && bodyCsrf.length > 0;
        const decisionOk = decision === 'allow' || decision === 'deny';
        if (!originOk || !csrfOk || !decisionOk) {
          res.status(403);
          const hint = !originOk ? `origin (${requestOrigin || 'none'} vs ${hostOrigin})`
            : !csrfOk ? 'csrf' : 'decision';
          return page(res, 'Connection blocked',
            `<p>Start again from your MCP client.</p><p><small>${escapeHtml(hint)}</small></p>`);
        }
        const callback = await provider.consent(request, bodyCsrf, sessionCookie(req), decision === 'allow');
        res.clearCookie('moh_mcp_consent', { path: '/mcp/consent' });
        // 303 Location is the protocol path. Some embedded browsers swallow that
        // navigation after a form POST; keep an HTML continue link + meta refresh.
        res.status(303).setHeader('Location', callback);
        return page(res, 'Returning to your MCP client',
          `<meta http-equiv="refresh" content="0;url=${escapeHtml(callback)}"><p>If this doesn’t continue automatically, <a href="${escapeHtml(callback)}">open your MCP client</a>.</p>`);
      }
      const csrf = req.cookies?.moh_mcp_consent;
      const pending = await provider.consentRequest(request, csrf);
      if (req.method !== 'GET') return res.status(405).end();
      const account = await provider.resolveAccount(sessionCookie(req));
      const web = escapeHtml(frontendUrl.replace(/\/+$/, ''));
      if (!account) {
        return page(res, 'Sign in to connect', `<p>Connecting your AI to Men of Hunger is part of Premium. Sign in to Men of Hunger with your own Premium account, then return to this tab.</p><p><a href="${web}" target="_blank" rel="noopener noreferrer">Open Men of Hunger</a> · <a href="${web}/tiers" target="_blank" rel="noopener noreferrer">See Premium</a></p><p><a href="/mcp/consent?request=${escapeHtml(request)}">I’m signed in — continue</a></p>`);
      }
      const form = (label) => `<form method="post" action="/mcp/consent"><input type="hidden" name="request" value="${escapeHtml(request)}"><input type="hidden" name="csrf" value="${escapeHtml(csrf)}"><button name="decision" value="allow">${label}</button><button name="decision" value="deny">Cancel</button></form><p><small>Environment: ${escapeHtml(baseUrl)}</small></p>`;
      const who = `<strong>@${escapeHtml(account.username || account.id)}</strong>`;
      if (account.audience === 'member') {
        return page(res, 'Connect your AI to Men of Hunger', `<p>${escapeHtml(pending.clientName)} is requesting read-only access as ${who}.</p><p>Your AI can read the lodge as you see it: the feed, posts and replies, member profiles, articles, your bookmarks, and your notifications. It cannot read direct messages or group conversations.</p><p><strong>It cannot post, reply, react, follow, or message for you.</strong> Reading never marks notifications seen. You show up and respond yourself.</p><p>Up to ${allowance.daily} requests per day. You can disconnect this client in its settings at any time.</p>${form('Allow read-only access')}`);
      }
      return page(res, 'Connect Men of Hunger', `<p>${escapeHtml(pending.clientName)} is requesting read and delegated-action access as ${who}.</p><p>Access includes company analytics, member account diagnostics, support and moderation queues, public posts, newsletters, verification, search history, MARV usage, referrals, and crew administration data, your delegated jobs, and their account-specific activity and drafts. Support content may contain personal information.</p><p>This connection can create and manage delegated jobs, and apply actions you authorize as your account or pages you operate. Jobs can continue after this chat ends until you pause or cancel them in Delegated work. You can disconnect this client in Cursor or ChatGPT.</p>${form('Allow delegated actions')}`);
    } catch {
      res.status(400); page(res, 'Reconnect from your MCP client', '<p>This connection request expired or your Men of Hunger sign-in could not be verified. Start again from your MCP client.</p>');
    }
  });

  router.all('/mcp', rateLimit({ windowMs: 60_000, limit: 120, legacyHeaders: false }),
    requireBearerAuth({ verifier: provider,
      resourceMetadataUrl: `${origin}/.well-known/oauth-protected-resource/mcp` }),
    async (req, res) => {
      const allowedOrigins = new Set([origin, 'https://chatgpt.com', 'https://www.cursor.com', 'https://cursor.com']);
      if (req.headers.origin && !allowedOrigins.has(req.headers.origin))
        return res.status(403).json({ error: 'invalid_origin' });
      if (req.method !== 'POST') return res.status(405).setHeader('Allow', 'POST').end();
      const member = req.auth.extra.audience === 'member';
      if (!req.auth.scopes.includes(member ? MEMBER_READ_SCOPE : READ_SCOPE))
        return res.status(403).json({ error: 'insufficient_scope' });
      // A request-bound session never touches local credentials or files. The
      // canonical product guards still authorize every underlying API read.
      const store = {
        credentialName: () => 'remote',
        read: async () => ({ baseUrl, token: req.auth.extra.sessionToken,
          expiresAt: new Date(req.auth.expiresAt * 1000).toISOString() }),
        write: async () => {},
      };
      const api = new MohApi({ baseUrl, store, fetchImpl: (input, init) => fetchImpl(input, { ...init, headers: { ...init.headers, Origin: frontendUrl } }) });
      const userId = req.auth.extra.userId;
      const server = member
        ? createMemberServer({ api, webUrl: frontendUrl,
          usage: () => allowance.usage(userId), beforeCall: () => allowance.consume(userId) })
        : createServer({ api, store, localArtifacts: false, remoteWrites: req.auth.scopes.includes(WRITE_SCOPE) });
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
