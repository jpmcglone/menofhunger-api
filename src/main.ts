import 'reflect-metadata';
import { NestFactory } from '@nestjs/core';
import helmet from 'helmet';
import { SwaggerModule, DocumentBuilder } from '@nestjs/swagger';
import * as cookieParser from 'cookie-parser';
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

function isUnsafeMethod(method: string | undefined) {
  const m = (method ?? '').toUpperCase();
  return m === 'POST' || m === 'PUT' || m === 'PATCH' || m === 'DELETE';
}

async function bootstrap() {
  const logger = new Logger('HTTP');
  const startup = new Logger('Startup');
  const app = await NestFactory.create<NestExpressApplication>(AppModule);

  const appConfig = app.get(AppConfigService);

  // Make route-specific rate limits available to Throttler resolvers.
  // (Stored on Express app locals so it can be accessed from ExecutionContext without DI.)
  const http = app.getHttpAdapter().getInstance();
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
  app.use(express.json({ limit: appConfig.bodyJsonLimit() }));
  app.use(express.urlencoded({ extended: true, limit: appConfig.bodyUrlEncodedLimit() }));

  // Cookies (auth).
  app.use(cookieParser());

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

    const origin = String(req.headers.origin ?? '').trim();
    const referer = String(req.headers.referer ?? '').trim();

    // In production, require Origin/Referer so cookie-auth endpoints can't be CSRF'd.
    // In development, allow missing Origin/Referer for convenience (curl/Postman).
    if (!origin && !referer) {
      if (appConfig.isProd() && appConfig.requireCsrfOriginInProd()) {
        return res.status(403).json({
          meta: {
            status: 403,
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
          errors: [{ code: 403, message: 'CSRF blocked', reason: 'csrf' }],
        },
      });
    }

    return next();
  });

  app.useGlobalInterceptors(new ApiResponseInterceptor());
  app.useGlobalFilters(new ApiExceptionFilter());
  app.enableShutdownHooks();

  const port = appConfig.port();

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

  await app.listen(port);
}

void bootstrap();

