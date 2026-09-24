import { createRequire } from 'node:module';
import { resolve } from 'node:path';
import type { Request, Response, RequestHandler } from 'express';
import type { AuthService } from '../auth/auth.service';
import type { AppConfigService } from '../app/app-config.service';
import type { RedisService } from '../redis/redis.service';
import { getSessionCookie } from '../../common/session-cookie';
import { localApiFetch } from './mcp-tools';
import { isOwnAdminSession } from '../admin/admin-session';
import type { SessionResult } from '../auth/auth.service';

export type McpAccount = { id: string; username: string | null; audience: 'admin' | 'member' };

type RemoteOptions = {
  redis: ReturnType<RedisService['raw']>;
  secret: string;
  baseUrl: string;
  frontendUrl: string;
  memberDailyCalls: number;
  resolveAccount: (token: string | undefined) => Promise<McpAccount | null>;
  createSession: (userId: string) => Promise<{ token: string; expiresAt: string }>;
  revokeSession: (token: string) => Promise<void>;
  sessionCookie: (req: Request) => string | undefined;
  fetchImpl: typeof fetch;
};

/**
 * Administrators get the founder catalog. Premium members (grants included) get the
 * read-only member catalog. Impersonated, page-operated, and banned sessions get neither.
 */
export function mcpAccountFor(session: SessionResult | null): McpAccount | null {
  if (!session || session.impersonatedByUserId || session.operatedByUserId) return null;
  const { user } = session;
  if (isOwnAdminSession(session)) return { id: user.id, username: user.username, audience: 'admin' };
  if (user.bannedAt) return null;
  if (user.accountKind !== 'person' || !(user.premium || user.premiumPlus)) return null;
  return { id: user.id, username: user.username, audience: 'member' };
}

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
    memberDailyCalls: config.mcpMemberDailyCalls(),
    resolveAccount: async (token) => mcpAccountFor(await auth.meFromSessionToken(token)),
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
