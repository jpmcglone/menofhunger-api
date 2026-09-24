import { Injectable } from '@nestjs/common';
import { createRequire } from 'node:module';
import { resolve } from 'node:path';
import { AuthService } from '../auth/auth.service';
import { AppConfigService } from '../app/app-config.service';
import { RedisService } from '../redis/redis.service';
import type { McpConnectionItemDto, McpUsageDto } from '../../common/dto/mcp.dto';

type Allowance = { usage: (userId: string) => Promise<McpUsageDto> };
type Connections = {
  list: (userId: string) => Promise<McpConnectionItemDto[]>;
  revoke: (userId: string, connectionId: string) => Promise<boolean>;
};

/** Reads and ends a person's hosted MCP connections using the same store as `/mcp`. */
@Injectable()
export class McpConnectionsService {
  private shared: { allowance: Allowance; connections: Connections } | null = null;

  constructor(
    private readonly auth: AuthService,
    private readonly config: AppConfigService,
    private readonly redis: RedisService,
  ) {}

  get url(): string {
    return `${new URL(this.config.browserHandoffBaseUrl()).origin}/mcp`;
  }

  usage(userId: string): Promise<McpUsageDto> {
    return this.load().allowance.usage(userId);
  }

  list(userId: string): Promise<McpConnectionItemDto[]> {
    return this.load().connections.list(userId);
  }

  revoke(userId: string, connectionId: string): Promise<boolean> {
    return this.load().connections.revoke(userId, connectionId);
  }

  // Loaded on first use, like the hosted MCP itself, so the ESM package stays out of module-graph load.
  private load() {
    if (!this.shared) {
      const load = (file: string): any => createRequire(__filename)(resolve(__dirname, `../../../tools/mcp/src/${file}`));
      const redis = this.redis.raw();
      this.shared = {
        allowance: load('allowance.mjs').memberAllowance(redis, { daily: this.config.mcpMemberDailyCalls() }),
        connections: load('oauth.mjs').connectionManager({
          redis,
          secret: this.config.sessionHmacSecret(),
          resourceUrl: this.url,
          revokeSession: (token: string) => this.auth.revokeSessionToken(token),
        }),
      };
    }
    return this.shared;
  }
}
