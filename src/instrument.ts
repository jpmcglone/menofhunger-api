import * as Sentry from '@sentry/nestjs';
import { scrubSentryEvent } from './common/sentry/sentry-scrub';

// Loaded before Nest so auto-instrumentation can patch http, express, Prisma, and ioredis.
// Reads process.env directly because AppConfigService does not exist yet.
const dsn = process.env.SENTRY_DSN?.trim();
const nodeEnv = (process.env.NODE_ENV ?? 'development').trim().toLowerCase();
const isProd = nodeEnv === 'production';
const configuredRate = Number(process.env.SENTRY_TRACES_SAMPLE_RATE?.trim() || NaN);
const tracesSampleRate = Number.isFinite(configuredRate) ? configuredRate : isProd ? 0.05 : 1;
const UNSAMPLED_PATH = /^\/(?:v\d+\/)?(?:health|socket\.io)(?:[/?]|$)/;

if (dsn) {
  Sentry.init({
    dsn,
    environment: process.env.SENTRY_ENVIRONMENT?.trim() || nodeEnv,
    release: process.env.RENDER_GIT_COMMIT?.trim() || undefined,
    dataCollection: {
      userInfo: false,
      cookies: false,
      httpBodies: [],
      httpHeaders: { request: { deny: ['cookie', 'authorization', 'stripe-signature'] }, response: false },
    },
    tracesSampler: ({ name, normalizedRequest, inheritOrSampleWith }) => {
      const path = normalizedRequest?.url ? new URL(normalizedRequest.url, 'http://x').pathname : name.split(' ')[1];
      if (name.startsWith('OPTIONS ') || (path && UNSAMPLED_PATH.test(path))) return 0;
      return inheritOrSampleWith(tracesSampleRate);
    },
    beforeSend: (event) => scrubSentryEvent(event),
  });
}
