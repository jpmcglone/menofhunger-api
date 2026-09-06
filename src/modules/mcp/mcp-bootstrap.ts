import { createRequire } from 'node:module';
import { resolve } from 'node:path';
import type { Request, Response, RequestHandler } from 'express';
import type { AuthService } from '../auth/auth.service';
import type { AppConfigService } from '../app/app-config.service';
import type { RedisService } from '../redis/redis.service';
import { getSessionCookie } from '../../common/session-cookie';
import { localApiFetch } from './mcp-tools';
import { isOwnAdminSession } from '../admin/admin-session';

type RemoteOptions = {
  redis: ReturnType<RedisService['raw']>;
  secret: string;
  baseUrl: string;
  frontendUrl: string;
  resolveAdmin: (token: string | undefined) => Promise<{ id: string; username: string | null } | null>;
  createSession: (userId: string) => Promise<{ token: string; expiresAt: string }>;
  revokeSession: (token: string) => Promise<void>;
  sessionCookie: (req: Request) => string | undefined;
  fetchImpl: typeof fetch;
};

export function createMcpMiddleware(config: AppConfigService, auth: AuthService, redis: RedisService): RequestHandler {
  // Node 20.19+ loads synchronous ESM graphs from CommonJS. The same package is
  // used by the CLI, stdio, and HTTP; no second tool registry or bundled copy.
  const { createRemoteMcp } = createRequire(__filename)(
    resolve(__dirname, '../../../tools/mcp/src/remote.mjs'),
  ) as { createRemoteMcp: (options: RemoteOptions) => RequestHandler };
  const baseUrl = config.browserHandoffBaseUrl();
  return createRemoteMcp({
    redis: redis.raw(),
    secret: config.sessionHmacSecret(),
    baseUrl,
    frontendUrl: config.frontendBaseUrl() || 'http://localhost:3000',
    resolveAdmin: async (token) => {
      const session = await auth.meFromSessionToken(token);
      return isOwnAdminSession(session)
        ? { id: session.user.id, username: session.user.username }
        : null;
    },
    createSession: async (userId) => {
      let token = '';
      // Capture a dedicated product session without replacing the browser's cookie.
      const response = { cookie: (_name: string, value: string) => { token = value; } } as Response;
      const session = await auth.createSessionForUser(userId, response);
      return { token, expiresAt: session.expiresAt.toISOString() };
    },
    revokeSession: (token) => auth.revokeSessionToken(token),
    sessionCookie: getSessionCookie,
    fetchImpl: localApiFetch(config),
  });
}
