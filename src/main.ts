import 'reflect-metadata';
import { NestFactory } from '@nestjs/core';
import helmet from 'helmet';
import { SwaggerModule, DocumentBuilder } from '@nestjs/swagger';
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

function isStripeWebhookPath(req: Request): boolean {
  const path = String(req.originalUrl || req.url || '');
  return path === '/billing/webhook' || path.startsWith('/billing/webhook?');
}

async function bootstrap() {
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
  if (!process.env.DATABASE_URL?.trim()) missing.push('DATABASE_URL');
  if (appConfig.isProd()) {
    const sessionSecret = process.env.SESSION_HMAC_SECRET?.trim();
    const otpSecret = process.env.OTP_HMAC_SECRET?.trim();
    const devSession = 'dev-session-secret-change-me';
    const devOtp = 'dev-otp-secret-change-me';
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
    const path = String(req.originalUrl || req.url || '');
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

  const swaggerConfig = new DocumentBuilder()
    .setTitle('Men of Hunger API')
    .setDescription('NestJS API intended for consumption by a Next.js app.')
    .setVersion('0.1.0')
    .build();
  const document = SwaggerModule.createDocument(app, swaggerConfig);
  SwaggerModule.setup('docs', app, document);

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

