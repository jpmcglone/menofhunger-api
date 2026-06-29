import 'reflect-metadata';
import { NestFactory } from '@nestjs/core';
import helmet from 'helmet';
import { SwaggerModule, DocumentBuilder } from '@nestjs/swagger';
import { apiReference } from '@scalar/nestjs-api-reference';
import cookieParser = require('cookie-parser');
import compression = require('compression');
import * as express from 'express';
import { randomUUID } from 'crypto';
import type { Request, Response, NextFunction } from 'express';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { Logger } from '@nestjs/common';
import { AppModule } from './modules/app/app.module';
import { ApiResponseInterceptor } from './common/interceptors/api-response.interceptor';
import { ApiExceptionFilter } from './common/filters/api-exception.filter';
import { AppConfigService } from './modules/app/app-config.service';
import { PresenceIoAdapter } from './common/adapters/presence-io.adapter';
import { RequestCacheService } from './common/cache/request-cache.service';

function isUnsafeMethod(method: string | undefined) {
  const m = (method ?? '').toUpperCase();
  return m === 'POST' || m === 'PUT' || m === 'PATCH' || m === 'DELETE';
}

/**
 * Strip an optional leading /vN/ (or /vN) REST API version prefix from a request path.
 *
 * Used in middleware that must recognize both versioned and unversioned forms of
 * the small set of operational endpoints that deliberately live at the document root
 * (never receive the /v1 prefix):
 *
 *   - '' (root identity)
 *   - health, health/config
 *   - billing/webhook (Stripe target)
 *   - .well-known/apple-app-site-association
 *
 * This normalization lives in one place so the list of unversioned surfaces stays consistent
 * during transition windows and future version bumps.
 */
function stripVersionPrefix(p: string): string {
  return p.replace(/^\/v\d+\/?/, '/');
}

function isStripeWebhookPath(req: Request): boolean {
  let path = String(req.originalUrl || req.url || '');
  // Normalize away a leading /vN prefix so the check remains correct even if
  // the webhook path were ever (incorrectly) requested under a version prefix,
  // or during any transition window. The actual webhook route is excluded from versioning.
  path = stripVersionPrefix(path);
  return path === '/billing/webhook' || path.startsWith('/billing/webhook?');
}

function isAppleIapNotificationPath(req: Request): boolean {
  let path = String(req.originalUrl || req.url || '');
  path = stripVersionPrefix(path);
  return path === '/billing/apple/notifications' || path.startsWith('/billing/apple/notifications?');
}

function installProcessStabilityHandlers(): void {
  const g = globalThis as any;
  if (g.__mohProcessHandlersInstalled) return;
  g.__mohProcessHandlersInstalled = true;

  const logger = new Logger('Process');
  process.on('unhandledRejection', (reason) => {
    logger.error(`Unhandled promise rejection: ${reason instanceof Error ? reason.stack ?? reason.message : String(reason)}`);
  });
}

async function bootstrap() {
  installProcessStabilityHandlers();
  const logger = new Logger('HTTP');
  const startup = new Logger('Startup');
  const nodeEnv = (process.env.NODE_ENV ?? 'development').trim().toLowerCase();
  const isProd = nodeEnv === 'production';
  // Logging can be surprisingly expensive under load; keep production lean.
  const app = await NestFactory.create<NestExpressApplication>(AppModule, {
    logger: isProd ? (['error', 'warn', 'log'] as const) : (['error', 'warn', 'log', 'debug', 'verbose'] as const),
  });

  const appConfig = app.get(AppConfigService);
  const requestCache = app.get(RequestCacheService);

  // Fail fast if required env is missing (avoids obscure runtime failures on first DB/auth use).
  const missing: string[] = [];
  if (!appConfig.databaseUrlIsSet()) missing.push('DATABASE_URL');
  if (appConfig.isProd()) {
    const devSession = 'dev-session-secret-change-me';
    const devOtp = 'dev-otp-secret-change-me';
    const sessionSecret = appConfig.sessionHmacSecret();
    const otpSecret = appConfig.otpHmacSecret();
    if (!sessionSecret || sessionSecret === devSession) missing.push('SESSION_HMAC_SECRET (must be set and not dev default in production)');
    if (!otpSecret || otpSecret === devOtp) missing.push('OTP_HMAC_SECRET (must be set and not dev default in production)');
  }
  if (missing.length > 0) {
    startup.error(`Missing or invalid required env: ${missing.join('; ')}. Exiting.`);
    process.exit(1);
  }

  // Make route-specific rate limits available to Throttler resolvers.
  // (Stored on Express app locals so it can be accessed from ExecutionContext without DI.)
  const http = app.getHttpAdapter().getInstance();
  // API responses should not be conditional-cached via ETag/If-None-Match.
  // Some clients (Nuxt/$fetch) treat 304 as an error, which can cause retry loops.
  http.disable?.('etag');
  http.locals = http.locals ?? {};
  http.locals.mohRateLimits = {
    authStart: { limit: appConfig.rateLimitAuthStartLimit(), ttl: appConfig.rateLimitAuthStartTtlSeconds() },
    authVerify: { limit: appConfig.rateLimitAuthVerifyLimit(), ttl: appConfig.rateLimitAuthVerifyTtlSeconds() },
    postCreate: { limit: appConfig.rateLimitPostCreateLimit(), ttl: appConfig.rateLimitPostCreateTtlSeconds() },
    interact: { limit: appConfig.rateLimitInteractLimit(), ttl: appConfig.rateLimitInteractTtlSeconds() },
    upload: { limit: appConfig.rateLimitUploadLimit(), ttl: appConfig.rateLimitUploadTtlSeconds() },
  };

  if (appConfig.trustProxy()) {
    // Required for correct req.ip / req.protocol behind reverse proxies (Cloudflare, ALB, etc).
    // IMPORTANT: only enable when you actually have a trusted proxy in front.
    app.set('trust proxy', 1);
  }

  /**
   * Paths that deliberately remain at the document root (never receive the /v1 prefix).
   * These are stable operational surfaces used by load balancers, Stripe, Apple, etc.
   *
   * This is the single source of truth for the unversioned surface.
   * Any new unversioned endpoint must be added here and to the exclude list below
   * (and the corresponding normalization in stripVersionPrefix + docs) in the same change.
   */
  const UNVERSIONED_ROOT_PATHS = [
    '', // root identity (GET /)
    'health',
    'health/config',
    'billing/webhook',
    '.well-known/apple-app-site-association',
  ] as const;

  // URL versioning for the entire public + admin API surface.
  //
  // The operational endpoints listed in UNVERSIONED_ROOT_PATHS above are kept at the
  // document root. Middleware normalizers and client health probes must continue to
  // recognize them without a version prefix.
  app.setGlobalPrefix('v1', {
    exclude: [...UNVERSIONED_ROOT_PATHS],
  });

  if (!appConfig.isProd() && appConfig.logStartupInfo()) {
    startup.log(
      [
        `nodeEnv=${appConfig.nodeEnv()}`,
        `port=${appConfig.port()}`,
        `trustProxy=${appConfig.trustProxy()}`,
        `allowedOrigins=${appConfig.allowedOrigins().join(',') || '(none)'}`,
        `csrfRequireOriginInProd=${appConfig.requireCsrfOriginInProd()}`,
        `bodyJsonLimit=${appConfig.bodyJsonLimit()}`,
        `bodyUrlEncodedLimit=${appConfig.bodyUrlEncodedLimit()}`,
        `throttle.global=${appConfig.rateLimitLimit()}/${appConfig.rateLimitTtlSeconds()}s`,
        `throttle.authStart=${appConfig.rateLimitAuthStartLimit()}/${appConfig.rateLimitAuthStartTtlSeconds()}s`,
        `throttle.authVerify=${appConfig.rateLimitAuthVerifyLimit()}/${appConfig.rateLimitAuthVerifyTtlSeconds()}s`,
        `throttle.postCreate=${appConfig.rateLimitPostCreateLimit()}/${appConfig.rateLimitPostCreateTtlSeconds()}s`,
        `throttle.interact=${appConfig.rateLimitInteractLimit()}/${appConfig.rateLimitInteractTtlSeconds()}s`,
        `throttle.upload=${appConfig.rateLimitUploadLimit()}/${appConfig.rateLimitUploadTtlSeconds()}s`,
      ].join(' | '),
    );
  }

  // Security headers (API-safe defaults).
  app.use(
    helmet({
      crossOriginResourcePolicy: false,
      // API typically doesn't need a CSP; avoid accidental breakage.
      contentSecurityPolicy: false,
    }),
  );

  // Compression for JSON payloads (feeds benefit a lot).
  app.use(compression());

  // Body limits (protect memory).
  // Capture raw JSON body for webhook signature verification (Stripe requires exact bytes).
  app.use(
    express.json({
      limit: appConfig.bodyJsonLimit(),
      verify: (req, _res, buf) => {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        (req as any).rawBody = buf;
      },
    }),
  );
  app.use(express.urlencoded({ extended: true, limit: appConfig.bodyUrlEncodedLimit() }));

  // Cookies (auth).
  app.use(cookieParser());

  // Sensitive endpoints should never be cached (prevents 304 loops in production behind CDNs/proxies,
  // and avoids caching auth state).
  app.use((req: Request, res: Response, next: NextFunction) => {
    let path = String(req.originalUrl || req.url || '');
    // Recognize both the versioned (/v1/admin, /v1/auth) and unversioned forms so the
    // no-store behavior works during the cutover window and for any clients that might
    // still be pointed at the old base temporarily.
    path = stripVersionPrefix(path);
    const isAdmin = path.startsWith('/admin/') || path === '/admin';
    const isAuth = path.startsWith('/auth/') || path === '/auth' || path.startsWith('/auth?');
    if (isAdmin || isAuth) {
      res.setHeader('Cache-Control', 'no-store');
      res.setHeader('Pragma', 'no-cache');
      res.setHeader('Expires', '0');
    }
    next();
  });

  // Request-scoped memoization (AsyncLocalStorage). Must run before controllers/guards/services.
  app.use((_req: Request, _res: Response, next: NextFunction) => {
    requestCache.runWithNewStore(() => next());
  });

  // Request id (for tracing + debugging). Returned as `x-request-id`.
  app.use((req: Request, res: Response, next: NextFunction) => {
    const incoming = String(req.headers['x-request-id'] ?? '').trim();
    const id = incoming || randomUUID();
    res.setHeader('x-request-id', id);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (req as any).requestId = id;
    next();
  });

  // Dev-only: lightweight request logging (opt-in via LOG_REQUESTS=true).
  // Intentionally logs the raw incoming path (including any /vN prefix) so developers
  // see exactly what clients are sending during version cutovers.
  if (!appConfig.isProd() && appConfig.logRequests()) {
    app.use((req: Request, res: Response, next: NextFunction) => {
      const start = Date.now();
      const method = String(req.method || '');
      const path = String(req.originalUrl || req.url || '');
      res.on('finish', () => {
        const ms = Date.now() - start;
        const rid = String(res.getHeader('x-request-id') ?? '');
        logger.log(`${method} ${path} -> ${res.statusCode} (${ms}ms)${rid ? ` rid=${rid}` : ''}`);
      });
      next();
    });
  }

  // CSRF mitigation for cookie-auth:
  // for unsafe methods, if a browser sends an Origin/Referer, it must be allowed.
  // This blocks cross-site form/fetch attacks when cookies are present.
  app.use((req: Request, res: Response, next: NextFunction) => {
    if (!isUnsafeMethod(req.method)) return next();
    // Allow third-party webhooks (no Origin/Referer).
    if (isStripeWebhookPath(req)) return next();
    if (isAppleIapNotificationPath(req)) return next();

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const requestId = String((req as any)?.requestId ?? '').trim() || null;
    const origin = String(req.headers.origin ?? '').trim();
    const referer = String(req.headers.referer ?? '').trim();

    // In production, require Origin/Referer so cookie-auth endpoints can't be CSRF'd.
    // In development, allow missing Origin/Referer for convenience (curl/Postman).
    if (!origin && !referer) {
      if (appConfig.isProd() && appConfig.requireCsrfOriginInProd()) {
        return res.status(403).json({
          meta: {
            status: 403,
            ...(requestId ? { requestId } : {}),
            errors: [{ code: 403, message: 'CSRF blocked', reason: 'csrf_missing_origin' }],
          },
        });
      }
      return next();
    }

    const host = String(req.headers.host ?? '').trim();
    const proto = req.protocol || 'http';
    const selfOrigin = host ? `${proto}://${host}` : '';

    const originAllowed =
      (origin && (appConfig.isOriginAllowed(origin) || (selfOrigin && origin === selfOrigin))) ||
      (!origin && referer && (referer.startsWith(selfOrigin) || appConfig.allowedOrigins().some((o) => referer.startsWith(o))));

    if (!originAllowed) {
      return res.status(403).json({
        meta: {
          status: 403,
          ...(requestId ? { requestId } : {}),
          errors: [{ code: 403, message: 'CSRF blocked', reason: 'csrf' }],
        },
      });
    }

    return next();
  });

  app.useGlobalInterceptors(new ApiResponseInterceptor());
  app.useGlobalFilters(new ApiExceptionFilter());
  app.enableShutdownHooks();

  app.useWebSocketAdapter(new PresenceIoAdapter(app, appConfig));

  const port = appConfig.port();

  if (!appConfig.runHttp()) {
    startup.log('RUN_HTTP=false: HTTP server disabled (running background jobs only).');
    return;
  }

  app.enableCors({
    credentials: true,
    origin: (origin: string | undefined, callback: (err: Error | null, allow?: boolean) => void) => {
      // Allow non-browser clients (no Origin header)
      if (!origin) return callback(null, true);
      if (appConfig.isOriginAllowed(origin)) return callback(null, true);
      // Avoid surfacing this as a 500; simply do not set CORS headers.
      // Browsers will block the response, and we log it server-side for clarity.
      appConfig.logCorsBlocked(origin);
      return callback(null, false);
    },
  });

  if (!appConfig.isProd()) {
    const documentConfig = new DocumentBuilder()
      .setTitle('Men of Hunger API')
      .setDescription(
        'Official API for Men of Hunger (v1).\n\n' +
          'SUCCESS ENVELOPE: All successful responses are wrapped as `{ data: T, pagination? }`.\n' +
          'ERROR ENVELOPE: `{ meta: { status, errors: [{ code, message, reason? }], requestId? } }` (produced by the global exception filter).\n\n' +
          'AUTH: HTTP-only cookie named `moh_session`. For unsafe methods (POST, PUT, PATCH, DELETE), browsers must send a matching Origin or Referer header that is in the allowed list (or same-origin) when running in production. This is the CSRF mitigation for cookie auth. Non-browser clients (curl, mobile apps) may omit Origin/Referer in development.\n\n' +
          'PAGINATION: List endpoints accept `?cursor=<opaque>&limit=N`. Responses include `pagination.nextCursor` (null when exhausted). Some endpoints also return counts by visibility tier.\n\n' +
          'RATE LIMITS: Global + operation-specific (auth start/verify, post creation, uploads, interactions). Limits are enforced via the Throttler guard; clients should respect Retry-After or back off on 429.\n\n' +
          'REALTIME (WebSocket): Primary transport for live updates. Connect to Socket.IO at `/socket.io` (engine.io v4). Authenticate with the same `moh_session` cookie.\n' +
          'Subscription model: After connect, clients call `posts:subscribe`, `articles:subscribe`, `presence:subscribe` (users), and room-specific joins for spaces/radio/crew-wall. The server then pushes targeted events.\n' +
          'Major event families (kebab-case, namespaced; payloads mirror the HTTP DTOs in src/common/dto/realtime.dto.ts and siblings):\n' +
          '  - posts:* (live-updated, interaction/boost/bookmark, comment-added/deleted, typing, feed:new-post for followers)\n' +
          '  - articles:* (live-updated, comment-added/deleted/updated, reaction changed)\n' +
          '  - users:meUpdated (canonical self), users:selfUpdated (public profile for subscribed users)\n' +
          '  - notifications:* (new, deleted, undelivered/waiting counts)\n' +
          '  - messages:* (created, edited, deleted, reaction, read receipts, typing, unread counts)\n' +
          '  - follows:changed\n' +
          '  - presence:* (status updated/cleared, online-feed snapshots, init/subscribed)\n' +
          '  - crews:* (updated, members changed, owner changed, disbanded, invites received/updated, wall messages + edits/deletes/reactions, streaks advanced/broken, transfer votes)\n' +
          '  - groups:* (invites received/updated)\n' +
          '  - spaces:* (lobby counts, members, chat messages/snapshots, reactions, typing, watch-party state/control/owner replaced, mode changed)\n' +
          '  - radio:* (listeners, lobby counts, chat messages/snapshots, replaced)\n' +
          '  - checkins:answered-today\n' +
          '  - marv:* (credits updated, public reply posted)\n' +
          'See the Realtime & Presence tag and the DTOs for exact payload shapes. Many events are also available via the HTTP presence controller helpers.\n\n' +
          'This reference is generated from the running NestJS application. New public routes and controllers appear automatically on next dev server restart (non-production). Production docs are intentionally disabled.\n\n' +
          'STABILITY CONTRACT: Within any v1.x release, response shapes, status codes, and error formats are stable. Breaking changes (field removal, type change, new required input, behavior change) will only be introduced behind a v2 path or equivalent. See docs/api-contract.md for the full type-sync and change process.',
      )
      .setVersion('0.1.0')
      .addCookieAuth('moh_session', {
        type: 'apiKey',
        in: 'cookie',
        name: 'moh_session',
      })
      .addTag('Auth', 'Phone (SMS/OTP) login, existence checks, session management, logout')
      .addTag('Feed & Posts', 'Home feed (following vs all, filters), create post/reply, comments, boosts, bookmarks, polls, drafts, delete own, view tracking')
      .addTag('Profiles & Social', 'Public profile, self profile (me), edit profile, follow/unfollow, nudge, relationship status, stats')
      .addTag('Notifications', 'Notification inbox (grouped + rollups), mark delivered/read, follow-back and nudge smart actions')
      .addTag('Moderation', 'Report a post or user (spam, harassment, etc.) - required surface for App Store safety and community health')
      .addTag('Uploads & Media', 'Generate presigned R2 upload URLs, avatar and banner management (including delete)')
      .addTag('Verification', 'Request identity verification, view status and requirements')
      .addTag('Search & Discovery', 'User and post search, trending hashtags, interest/topic categories, who-to-follow / recommendations')
      .addTag('Realtime & Presence', 'HTTP presence helpers and the full catalog of WebSocket events for live feed, notifications, presence, and cross-device sync')
      .addTag('Billing & Entitlements', 'Current subscription state, active grants, referral/recruit info (read-only surfaces for clients)')
      .addTag('Messages (Chat)', 'Conversations, messages, reactions, read receipts, blocks, typing, unread counts — full realtime + HTTP surface')
      .addTag('Articles', 'Long-form articles with comments, reactions, boosts, drafts, publishing, sharing')
      .addTag('Crews & Groups', 'Crew and community group membership, invites, wall chat, owner transfer, streaks, moderation')
      .addTag('Check-ins & Streaks', 'Daily check-in answers, today/leaderboard, streak events')
      .addTag('Radio & Spaces', 'Radio stations + live chat/lobbies; collaborative Spaces with watch parties, chat, reactions')
      .addTag('Other', 'Topics/interests/follows, daily-content, hashtags/trending, link metadata, feedback, app meta, public metrics')
      .build();
    const document = SwaggerModule.createDocument(app, documentConfig);

    app.use(
      '/docs',
      apiReference({
        content: document,
        pageTitle: 'Men of Hunger API Reference',
        theme: 'moon',
        contact: { url: 'https://menofhunger.com/feedback', email: 'feedback@menofhunger.com' },
      }),
    );

    http.get('/openapi.json', (req: Request, res: Response) => {
      res.json(document);
    });
  }

  try {
    await app.listen(port);
  } catch (err) {
    const code = (err as NodeJS.ErrnoException | undefined)?.code;
    if (code === 'EADDRINUSE') {
      startup.error(`Port ${port} is already in use.`);
      startup.error('Run: npm run dev:kill (or set PORT in .env)');
    } else {
      startup.error(`Failed to start server: ${(err as Error)?.message ?? String(err)}`);
    }
    process.exit(1);
  }
}

void bootstrap();

