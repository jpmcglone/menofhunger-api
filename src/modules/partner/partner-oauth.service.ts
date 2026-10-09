import { USER_BRIEF_SELECT, USER_REF_SELECT } from '../../common/prisma-selects/user.select';
import { NOT_BANNED_USER_WHERE } from '../../common/prisma-selects/user.where';
import { HttpException, Optional, Injectable, NotFoundException, UnauthorizedException } from '@nestjs/common';
import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import type { NextFunction, Request, Response } from 'express';
import { AppConfigService } from '../app/app-config.service';
import { PrismaService } from '../prisma/prisma.service';
import { AuthService } from '../auth/auth-public-api';
import { RedisService } from '../redis/redis.service';
import { getSessionCookie } from '../../common/session-cookie';
import { openSecret, sealSecret } from '../../common/crypto/secret-box';
import { partnerAdapter } from './partner-oidc.adapter';
import { PartnerAccessService } from './partner-access.service';
import { PartnerRateService } from './partner-rate.service';
import { PosthogService } from '../../common/posthog/posthog.service';
import { isFullyOnboarded } from '../users/onboarding.utils';
import { PARTNER_SCOPES } from './partner.constants';

const DAY = 86400;
const escape = (v: unknown) => String(v ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);
const hash = (s: string) => createHash('sha256').update(s).digest('hex');

@Injectable()
export class PartnerOAuthService {
  private instance: any;
  private initializing?: Promise<any>;
  constructor(
    private readonly cfg: AppConfigService,
    private readonly prisma: PrismaService,
    private readonly auth: AuthService,
    private readonly redis: RedisService,
    private readonly access: PartnerAccessService,
    private readonly rate: PartnerRateService,
    @Optional() private readonly analytics?: PosthogService,
  ) {}

  async provider(): Promise<any> {
    if (!this.cfg.partner().enabled) throw new NotFoundException();
    if (this.instance) return this.instance;
    if (this.initializing) return this.initializing;
    this.initializing = this.initialize().catch((e) => {
      this.initializing = undefined;
      throw e;
    });
    return this.initializing;
  }
  private async initialize() {
    const config = this.cfg.partner();
    if (config.encryptionKey.length < 32 || !config.jwks) throw new Error('Partner OAuth requires signing keys and a dedicated encryption key.');
    const { Provider, errors } = require('oidc-provider');
    const resource = `${new URL(config.issuer).origin}/v1/partner`;
    const baseAdapter = partnerAdapter(this.prisma, config.encryptionKey);
    const prisma = this.prisma;
    const access = this.access;
    class Adapter extends baseAdapter {
      constructor(private readonly modelName: string) {
        super(modelName);
      }
      async find(id: string) {
        if (this.modelName === 'Grant') {
          try {
            await access.grant(id);
          } catch {
            return undefined;
          }
        }
        if (this.modelName !== 'Client') return super.find(id);
        const row = await prisma.partnerClient.findUnique({ where: { id } });
        if (!row?.active) return undefined;
        return {
          client_id: row.id,
          client_secret: openSecret(row.secretEnc, config.encryptionKey),
          redirect_uris: row.redirectUris,
          post_logout_redirect_uris: row.logoutRedirectUris,
          grant_types: ['authorization_code', 'refresh_token'],
          response_types: ['code'],
          token_endpoint_auth_method: 'client_secret_basic',
          scope: row.scopes.join(' '),
        };
      }
    }
    const provider = new Provider(config.issuer, {
      renderError: async (ctx: any) => {
        ctx.type = 'html';
        ctx.body = '<h1>Connection could not be completed</h1><p>Return to the app and try connecting again.</p>';
      },
      adapter: Adapter,
      jwks: JSON.parse(config.jwks),
      cookies: { keys: [config.encryptionKey] },
      clients: [],
      scopes: [...PARTNER_SCOPES],
      routes: {
        authorization: '/authorize',
        token: '/token',
        userinfo: '/userinfo',
        jwks: '/jwks',
        revocation: '/revoke',
        introspection: '/introspect',
        end_session: '/logout',
      },
      pkce: { required: () => true, methods: ['S256'] },
      features: {
        devInteractions: { enabled: false },
        revocation: {
          enabled: true,
          allowedPolicy: (_ctx: any, client: any, token: any) => client.clientId === token.clientId,
        },
        introspection: {
          enabled: true,
          allowedPolicy: (_ctx: any, client: any, token: any) => client.clientId === token.clientId,
        },
        resourceIndicators: {
          enabled: true,
          defaultResource: () => resource,
          useGrantedResource: () => false,
          getResourceServerInfo: (_ctx: any, requested: string) => {
            if (requested !== resource) throw new errors.InvalidTarget('Unsupported resource');
            return {
              scope: PARTNER_SCOPES.filter((s) => !['openid', 'profile', 'offline_access'].includes(s)).join(' '),
              audience: resource,
              accessTokenFormat: 'opaque',
              accessTokenTTL: 900,
            };
          },
        },
      },
      claims: { openid: ['sub'], profile: ['name', 'preferred_username', 'profile', 'picture'] },
      ttl: {
        AccessToken: 900,
        IdToken: 900,
        AuthorizationCode: 300,
        Interaction: 600,
        Session: DAY,
        Grant: 180 * DAY,
        RefreshToken: (_ctx: any, token: any) =>
          Math.max(1, Math.min(30 * DAY, (token.iat ?? Math.floor(Date.now() / 1000)) + 180 * DAY - Math.floor(Date.now() / 1000))),
      },
      rotateRefreshToken: () => true,
      expiresWithSession: () => false,
      interactions: { url: (_ctx: any, interaction: any) => `/oauth/interaction/${interaction.uid}` },
      findAccount: async (_ctx: any, id: string, token: any) => {
        if (token?.grantId) await this.access.grant(token.grantId, token.clientId);
        const user = await this.prisma.user.findUnique({
          where: { id },
          select: { ...USER_BRIEF_SELECT, bannedAt: true, accountKind: true },
        });
        if (!user || user.bannedAt || user.accountKind !== 'person') return undefined;
        return {
          accountId: id,
          claims: async () => ({
            sub: id,
            name: user.name,
            preferred_username: user.username,
            profile: `${this.cfg.frontendBaseUrl()}/u/${encodeURIComponent(user.username ?? '')}`,
          }),
        };
      },
      loadExistingGrant: async (ctx: any) => {
        const grantId = ctx.oidc.result?.consent?.grantId;
        if (!grantId) return undefined; // Fresh explicit account selection for each connection.
        await this.access.grant(grantId, ctx.oidc.client.clientId);
        return provider.Grant.find(grantId);
      },
    });
    provider.proxy = this.cfg.trustProxy();
    provider.on('grant.revoked', (ctx: any, grantId: string) => {
      void this.access.revoke(grantId ?? ctx?.oidc?.entities?.Grant?.jti).catch(() => undefined);
    });
    this.instance = provider;
    return provider;
  }

  async tokenPrincipal(token: string) {
    const provider = await this.provider();
    const record = await provider.AccessToken.find(token);
    if (!record || record.isExpired || !record.grantId) throw new UnauthorizedException('Invalid or expired access token.');
    const audience = `${new URL(this.cfg.partner().issuer).origin}/v1/partner`;
    if (record.aud !== audience) throw new UnauthorizedException('Wrong token audience.');
    const value = await this.access.grant(record.grantId, record.clientId);
    return {
      ...value,
      scopes: String(record.scope ?? '')
        .split(' ')
        .filter((s: string) => value.grant.scopes.includes(s) && value.client.scopes.includes(s)),
    };
  }

  middleware() {
    return async (req: Request, res: Response, next: NextFunction) => {
      if (!(req.path === '/oauth' || req.path.startsWith('/oauth/'))) return next();
      res.setHeader('Cache-Control', 'no-store');
      res.setHeader('Referrer-Policy', 'no-referrer');
      try {
        const provider = await this.provider();
        if (req.path.startsWith('/oauth/interaction/')) return await this.interaction(provider, req, res);
        if (req.path === '/oauth/authorize') {
          const params = req.method === 'POST' ? req.body : req.query;
          if (!params.state || (String(params.scope).split(' ').includes('openid') && !params.nonce))
            return res.status(400).json({ error: 'invalid_request', error_description: 'state and an OpenID nonce are required.' });
        }
        if (req.path !== '/oauth/token') await this.protocolRate(provider, req, res);
        if (req.path === '/oauth/token') return await this.tokenRequest(provider, req, res);
        req.url = req.url.slice('/oauth'.length) || '/';
        return provider.callback()(req, res);
      } catch (e) {
        if (res.headersSent) return;
        const status = e instanceof HttpException ? e.getStatus() : 500;
        res.status(status).json({
          error: status === 404 ? 'not_found' : status === 429 ? 'temporarily_unavailable' : status >= 500 ? 'server_error' : 'invalid_request',
          error_description: 'Connection could not be completed. Restart from the application.',
        });
      }
    };
  }

  private async authenticatedClient(req: Request) {
    const credentials = /^Basic (.+)$/.exec(req.headers.authorization ?? '');
    const decoded = credentials ? Buffer.from(credentials[1], 'base64').toString() : '';
    const colon = decoded.indexOf(':');
    if (colon < 0) return null;
    let clientId: string, secret: string;
    try {
      clientId = decodeURIComponent(decoded.slice(0, colon));
      secret = decodeURIComponent(decoded.slice(colon + 1));
    } catch {
      return null;
    }
    const client = await this.prisma.partnerClient.findUnique({ where: { id: clientId } });
    if (!client?.active) return null;
    const expected = openSecret(client.secretEnc, this.cfg.partner().encryptionKey);
    return expected && timingSafeEqual(Buffer.from(hash(secret)), Buffer.from(hash(expected))) ? client : null;
  }

  private async protocolRate(provider: any, req: Request, res: Response) {
    if (req.path === '/oauth/userinfo') {
      const bearer = /^Bearer ([^\s]+)$/.exec(req.headers.authorization ?? '')?.[1];
      const token = bearer && (await provider.AccessToken.find(bearer));
      if (token && !token.isExpired && token.grantId) {
        try {
          const { grant, client } = await this.access.grant(token.grantId, token.clientId);
          await this.rate.check(
            [
              { key: `client:${client.id}`, limit: client.clientReadLimit },
              { key: `account:${client.id}:${grant.userId}`, limit: client.accountReadLimit },
            ],
            res,
          );
          return;
        } catch (error) {
          if (error instanceof HttpException && error.getStatus() === 429) throw error;
        }
      }
    }
    if (req.path === '/oauth/introspect' || req.path === '/oauth/revoke') {
      const client = await this.authenticatedClient(req);
      if (client) {
        await this.rate.check([{ key: `oauth-control:${client.id}`, limit: 600 }], res);
        return;
      }
    }
    // IP protection applies to unauthenticated protocol traffic, not every member
    // behind a partner's shared backend IP address.
    await this.rate.check([{ key: `oauth-ip:${req.ip}`, limit: 120 }], res);
  }

  private async tokenRequest(provider: any, req: Request, res: Response) {
    const client = await this.authenticatedClient(req);
    if (!client) {
      await this.rate.check([{ key: `auth-ip:${req.ip}`, limit: 30 }], res);
      return res.status(401).json({ error: 'invalid_client' });
    }
    await this.rate.check([{ key: `token:${client.id}`, limit: 600 }], res);
    const refresh = typeof req.body?.refresh_token === 'string' && req.body.grant_type === 'refresh_token' ? req.body.refresh_token : null;
    if (!refresh) {
      req.url = '/token';
      return provider.callback()(req, res);
    }
    const record = await provider.RefreshToken.find(refresh, { ignoreExpiration: true });
    if (!record || record.clientId !== client.id) return res.status(400).json({ error: 'invalid_grant' });
    try {
      await this.access.grant(record.grantId, client.id);
    } catch {
      return res.status(400).json({ error: 'invalid_grant' });
    }
    await this.rate.check([{ key: `refresh:${record.grantId}`, limit: 60 }], res);
    const fingerprint = hash(JSON.stringify([client.id, refresh, req.body.scope ?? '', req.body.resource ?? '']));
    const cacheKey = `partner:refresh:result:${fingerprint}`;
    const cached = await this.redis.getString(cacheKey);
    if (cached) return res.json(JSON.parse(openSecret(cached, this.cfg.partner().encryptionKey)));
    const lockKey = `partner:refresh:lock:${hash(refresh)}`;
    const lock = randomBytes(20).toString('hex');
    if (!(await this.redis.setString(lockKey, lock, { onlyIfAbsent: true, ttlSeconds: 30 }))) {
      res.setHeader('Retry-After', 1);
      return res.status(429).json({ error: 'temporarily_unavailable' });
    }
    // Capture only a successful provider response. Waiting workers replay it on their retry.
    const end = res.end.bind(res);
    res.end = ((chunk: any, ...args: any[]) => {
      const finish = async () => {
        try {
          if (res.statusCode === 200 && chunk)
            await this.redis.setString(cacheKey, sealSecret(Buffer.isBuffer(chunk) ? chunk.toString() : String(chunk), this.cfg.partner().encryptionKey), {
              ttlSeconds: 10,
            });
        } finally {
          await this.redis.raw().eval("if redis.call('GET',KEYS[1])==ARGV[1] then return redis.call('DEL',KEYS[1]) end return 0", 1, lockKey, lock);
          end(chunk, ...args);
        }
      };
      void finish().catch(() => {
        if (!res.writableEnded) end(chunk, ...args);
      });
      return res;
    }) as Response['end'];
    req.url = '/token';
    return provider.callback()(req, res);
  }

  private async interaction(provider: any, req: Request, res: Response) {
    const details = await provider.interactionDetails(req, res);
    const session = await this.auth.meFromSessionToken(getSessionCookie(req));
    const client = await this.prisma.partnerClient.findUnique({ where: { id: String(details.params.client_id) } });
    if (!client?.active) throw new UnauthorizedException();
    // Record the funnel before consent too, including members who later decline.
    // Never send the browser's continuation credential to analytics.
    if (this.analytics) {
      const flowId = hash(String(details.uid));
      if (await this.redis.setString(`partner:analytics:start:${flowId}`, '1', { onlyIfAbsent: true, ttlSeconds: DAY })) {
        this.analytics.capture(`partner-flow:${flowId}`, 'partner_connection_started', { clientId: client.id });
      }
      if (session && !session.impersonatedByUserId) {
        const humanId = session.operatedByUserId ?? session.user.id;
        if (
          await this.redis.setString(`partner:analytics:return:${flowId}:${humanId}`, '1', {
            onlyIfAbsent: true,
            ttlSeconds: DAY,
          })
        ) {
          this.analytics.capture(humanId, 'partner_connection_authenticated', {
            clientId: client.id,
            $set_once: { firstPartnerClientId: client.id },
          });
          const human = await this.prisma.user.findUnique({ where: { id: humanId }, select: { createdAt: true } });
          const startedAt = Number(details.iat) * 1000;
          if (
            human &&
            Number.isFinite(startedAt) &&
            human.createdAt.getTime() >= startedAt &&
            (await this.redis.setString(`partner:analytics:signup:${humanId}`, '1', {
              onlyIfAbsent: true,
              ttlSeconds: 30 * DAY,
            }))
          ) {
            this.analytics.capture(humanId, 'partner_attributed_signup', { clientId: client.id });
          }
        }
      }
    }
    if (!session || session.impersonatedByUserId) {
      const returnPath = `/oauth/interaction/${encodeURIComponent(details.uid)}`;
      const login = new URL('/login', this.cfg.frontendBaseUrl()!);
      // Resume via a same-origin website route; login deliberately rejects arbitrary external redirects.
      login.searchParams.set('redirect', `/connect/partner?interaction=${encodeURIComponent(details.uid)}`);
      return res
        .type('html')
        .send(
          `<h1>Connect Men of Hunger</h1><a href="${escape(login.href)}">Sign in or create an account</a><p>Return here after signing in.</p><a href="${escape(returnPath)}">Continue</a>`,
        );
    }
    const operatorId = session.operatedByUserId ?? session.user.id;
    const onboarding = await this.prisma.user.findUnique({
      where: { id: operatorId },
      select: { usernameIsSet: true, birthdate: true, interests: true, menOnlyConfirmed: true },
    });
    if (!onboarding || !isFullyOnboarded(onboarding)) {
      const setup = new URL('/connect/partner', this.cfg.frontendBaseUrl()!);
      setup.searchParams.set('interaction', details.uid);
      return res
        .type('html')
        .send(
          `<h1>Finish setting up Men of Hunger</h1><p>Complete your account before connecting an app.</p><a href="${escape(setup.href)}">Finish account setup</a>`,
        );
    }
    const requested = String(details.params.scope ?? '')
      .split(' ')
      .filter((s) => client.scopes.includes(s));
    const pages = await this.prisma.userPageOperator.findMany({
      where: { operatorUserId: operatorId },
      select: { pageUserId: true },
    });
    const accounts = await this.prisma.user.findMany({
      where: { id: { in: [operatorId, ...pages.map((p) => p.pageUserId)] }, ...NOT_BANNED_USER_WHERE },
      select: { ...USER_REF_SELECT, accountKind: true },
    });
    const csrfKey = `partner:consent:${details.uid}:${operatorId}`;
    if (req.method === 'POST') {
      const csrf = await this.redis.getString(csrfKey);
      if (!csrf || req.body?.csrf !== csrf || !accounts.some((a) => a.id === req.body?.accountId))
        return res.status(400).send('Connection request expired. Start again.');
      if (req.body.decision !== 'allow') return provider.interactionFinished(req, res, { error: 'access_denied' }, { mergeWithLastSubmission: false });
      await this.access.assertAccount(req.body.accountId, operatorId);
      const scopes = requested.filter(
        (s) => ['openid', 'offline_access', 'account:read'].includes(s) || (Array.isArray(req.body.scope) ? req.body.scope : [req.body.scope]).includes(s),
      );
      const grant = new provider.Grant({ accountId: operatorId, clientId: client.id });
      const identityScopes = scopes.filter((s) => ['openid', 'profile', 'offline_access'].includes(s));
      grant.addOIDCScope(scopes.join(' '));
      const rejected = requested.filter((s) => !scopes.includes(s));
      grant.rejectOIDCScope(rejected.join(' '));
      grant.rejectResourceScope(
        `${new URL(this.cfg.partner().issuer).origin}/v1/partner`,
        rejected.filter((s) => !['openid', 'profile', 'offline_access'].includes(s)).join(' '),
      );
      if (details.prompt.details.missingOIDCClaims) grant.rejectOIDCClaims(details.prompt.details.missingOIDCClaims);
      grant.addResourceScope(`${new URL(this.cfg.partner().issuer).origin}/v1/partner`, scopes.filter((s) => !identityScopes.includes(s)).join(' '));
      const grantId = await grant.save();
      await this.prisma.$transaction([
        this.prisma.partnerGrant.updateMany({
          where: { clientId: client.id, userId: req.body.accountId, revokedAt: null },
          data: { revokedAt: new Date() },
        }),
        this.prisma.partnerGrant.create({
          data: {
            id: grantId,
            clientId: client.id,
            userId: req.body.accountId,
            operatorUserId: operatorId,
            scopes,
            expiresAt: new Date(Date.now() + 180 * DAY * 1000),
          },
        }),
      ]);
      this.analytics?.capture(operatorId, 'partner_oauth_completed', {
        clientId: client.id,
        accountId: req.body.accountId,
        grantId,
        $set_once: { firstPartnerClientId: client.id },
      });
      await this.redis.raw().del(csrfKey);
      return provider.interactionFinished(req, res, { login: { accountId: operatorId }, consent: { grantId } }, { mergeWithLastSubmission: false });
    }
    const csrf = randomBytes(24).toString('base64url');
    await this.redis.setString(csrfKey, csrf, { ttlSeconds: 600 });
    const options = accounts.map((a) => `<option value="${escape(a.id)}">@${escape(a.username)}${a.accountKind === 'page' ? ' (page)' : ''}</option>`).join('');
    const labels: Record<string, string> = {
      profile: 'Your public sign-in profile',
      'verification:read': 'Your MOH verification status',
      'content:read': 'Public posts, articles and replies',
      'social:read': 'Your followers and following',
      'webhooks:read': 'Updates to the information you allow',
    };
    const permissions = requested
      .filter((s) => !['openid', 'offline_access', 'account:read'].includes(s))
      .map((s) => `<label><input type="checkbox" name="scope" value="${escape(s)}" checked> ${escape(labels[s] ?? s)}</label><br>`)
      .join('');
    return res.type('html')
      .send(`<!doctype html><html><head><meta name="viewport" content="width=device-width,initial-scale=1"><title>Connect Men of Hunger</title><style>
:root{color-scheme:light dark;font-family:Inter,system-ui,sans-serif;background:light-dark(#fff,#111);color:light-dark(#171717,#fafafa)}
body{margin:0;padding:24px}main{max-width:480px;margin:48px auto}h1{font-size:26px;line-height:1.2}p{line-height:1.6;color:light-dark(#555,#aaa)}
select{display:block;width:100%;padding:12px;margin:8px 0 20px;border:1px solid #888;border-radius:8px;font:inherit}label{display:inline-flex;align-items:center;min-height:44px;gap:10px}form>label:first-of-type{display:block}
input[type=checkbox]{width:20px;height:20px;accent-color:light-dark(#171717,#fafafa)}button{font:inherit;font-weight:600;min-height:44px;border-radius:8px;padding:10px 24px;margin:20px 8px 0 0;border:1px solid #888;cursor:pointer}button[value=allow]{background:light-dark(#171717,#fafafa);color:light-dark(#fff,#171717)}a{color:inherit}
</style></head><body><main><h1>Connect ${escape(client.name)}</h1><p>This app can read only the information you allow. It cannot publish to Men of Hunger.</p><form method="post"><input type="hidden" name="csrf" value="${csrf}"><label>MOH account <select name="accountId">${options}</select></label><p>Read the selected account’s basic profile.</p>${permissions}<button name="decision" value="allow">Connect</button> <button name="decision" value="deny">Cancel</button></form><p>Already connected? <a href="${escape(this.cfg.frontendBaseUrl())}/settings/integrations">Manage your connections</a>. Sharing outward is a separate permission and always your choice.</p></main></body></html>`);
  }
}
