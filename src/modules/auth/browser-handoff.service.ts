import * as crypto from 'node:crypto';
import { BadRequestException, Injectable, ServiceUnavailableException } from '@nestjs/common';
import type { Response } from 'express';
import type { BrowserHandoffDto } from '../../common/dto';
import { AppConfigService } from '../app/app-config.service';
import { RedisKeys } from '../redis/redis-keys';
import { RedisService } from '../redis/redis.service';
import { AuthService } from './auth.service';
import { randomSessionToken } from './auth.utils';

const HANDOFF_TTL_MS = 90_000;
const CONSUME_HANDOFF_LUA = `
  local payload = redis.call("get", KEYS[1])
  if payload then
    redis.call("del", KEYS[1])
  end
  return payload
`;

type StoredBrowserHandoff = {
  userId: string;
  destination: string;
  expiresAt: string;
};

export type BrowserHandoffRedemption = {
  destinationUrl: string;
};

@Injectable()
export class BrowserHandoffService {
  constructor(
    private readonly redis: RedisService,
    private readonly appConfig: AppConfigService,
    private readonly auth: AuthService,
  ) {}

  async mint(userId: string, requestedDestination?: string): Promise<BrowserHandoffDto> {
    const destination = this.normalizeDestination(requestedDestination);
    const expiresAt = new Date(Date.now() + HANDOFF_TTL_MS);
    const payload: StoredBrowserHandoff = {
      userId,
      destination,
      expiresAt: expiresAt.toISOString(),
    };

    for (let attempt = 0; attempt < 3; attempt += 1) {
      const code = randomSessionToken();
      const stored = await this.redis.setJson(RedisKeys.browserHandoff(this.hashCode(code)), payload, {
        ttlMs: HANDOFF_TTL_MS,
        onlyIfAbsent: true,
      });
      if (!stored) continue;

      const handoffUrl = new URL(`${this.appConfig.browserHandoffBaseUrl()}/auth/browser-handoff/redeem`);
      handoffUrl.searchParams.set('code', code);
      return {
        handoffUrl: handoffUrl.toString(),
        expiresAt: expiresAt.toISOString(),
      };
    }

    throw new ServiceUnavailableException('Could not create a browser handoff. Please try again.');
  }

  async redeem(code: string, res: Response): Promise<BrowserHandoffRedemption | null> {
    if (!/^[A-Za-z0-9_-]{43,}$/.test(code)) return null;

    const raw = await this.redis.raw().eval(CONSUME_HANDOFF_LUA, 1, RedisKeys.browserHandoff(this.hashCode(code)));
    if (typeof raw !== 'string') return null;

    let handoff: StoredBrowserHandoff;
    try {
      handoff = JSON.parse(raw) as StoredBrowserHandoff;
    } catch {
      return null;
    }

    const expiresAtMs = Date.parse(handoff.expiresAt);
    if (!handoff.userId || !Number.isFinite(expiresAtMs) || expiresAtMs <= Date.now()) {
      return null;
    }

    let destination: string;
    try {
      destination = this.normalizeDestination(handoff.destination);
    } catch {
      return null;
    }

    await this.auth.createSessionForUser(handoff.userId, res);
    return { destinationUrl: this.siteUrl(destination) };
  }

  invalidRedirectUrl(): string {
    const url = new URL('/login', this.siteOrigin());
    url.searchParams.set('handoffError', 'invalid_or_expired');
    return url.toString();
  }

  private normalizeDestination(destination?: string): string {
    const value = destination?.trim() || '/';
    if (
      !value.startsWith('/') ||
      value.startsWith('//') ||
      value.includes('\\') ||
      value.includes('#') ||
      /[\u0000-\u001F\u007F]/.test(value)
    ) {
      throw new BadRequestException('Destination must be a safe relative path and query.');
    }

    const parsed = new URL(value, 'https://handoff.invalid');
    if (parsed.origin !== 'https://handoff.invalid') {
      throw new BadRequestException('Destination must be a safe relative path and query.');
    }
    return `${parsed.pathname}${parsed.search}`;
  }

  private siteOrigin(): string {
    const configured = this.appConfig.frontendBaseUrl();
    if (!configured) {
      throw new ServiceUnavailableException('Browser handoff is not configured.');
    }
    const url = new URL(configured);
    if (url.protocol !== 'https:' && url.protocol !== 'http:') {
      throw new ServiceUnavailableException('Browser handoff is not configured.');
    }
    return url.origin;
  }

  private siteUrl(destination: string): string {
    return new URL(destination, this.siteOrigin()).toString();
  }

  private hashCode(code: string): string {
    return crypto.createHash('sha256').update(code).digest('hex');
  }
}
