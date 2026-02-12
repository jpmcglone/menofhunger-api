import { Injectable } from '@nestjs/common';
import { ThrottlerGuard } from '@nestjs/throttler';
import * as crypto from 'node:crypto';
import { Reflector } from '@nestjs/core';
import {
  InjectThrottlerOptions,
  InjectThrottlerStorage,
} from '@nestjs/throttler/dist/throttler.decorator';
import type { ThrottlerModuleOptions } from '@nestjs/throttler/dist/throttler-module-options.interface';
import type { ThrottlerStorage } from '@nestjs/throttler/dist/throttler-storage.interface';
import { getSessionCookie } from '../session-cookie';
import { PrismaService } from '../../modules/prisma/prisma.service';
import { AppConfigService } from '../../modules/app/app-config.service';
import {
  readSessionTokenUserCache,
  writeSessionTokenUserCache,
} from './session-token-user-cache';

/**
 * Throttling key strategy:
 * - If the request has a valid session cookie, throttle by user id (shared across sessions).
 * - Otherwise throttle by IP (keeps auth/start abuse controls effective).
 *
 * Note: We do not rely on `req.user` being set, because this guard runs globally and before
 * route-specific guards. Instead we resolve the session to a user id via the DB with a small cache.
 */
@Injectable()
export class MohThrottlerGuard extends ThrottlerGuard {
  constructor(
    @InjectThrottlerOptions() options: ThrottlerModuleOptions,
    @InjectThrottlerStorage() storageService: ThrottlerStorage,
    reflector: Reflector,
    private readonly prisma: PrismaService,
    private readonly appConfig: AppConfigService,
  ) {
    super(options, storageService, reflector);
  }

  private hmacSha256Hex(secret: string, value: string) {
    return crypto.createHmac('sha256', secret).update(value).digest('hex');
  }

  private async userIdFromSessionToken(token: string): Promise<string | null> {
    const now = new Date();
    const nowMs = now.getTime();
    const tokenHash = this.hmacSha256Hex(this.appConfig.sessionHmacSecret(), token);

    const cached = readSessionTokenUserCache(tokenHash, nowMs);
    if (cached !== undefined) return cached;

    const session = await this.prisma.session.findFirst({
      where: {
        tokenHash,
        revokedAt: null,
        expiresAt: { gt: now },
      },
      select: {
        userId: true,
        expiresAt: true,
      },
    });

    // Cache briefly to reduce DB pressure during bursts.
    // - Positive: up to 30s, but never past session expiry.
    // - Negative: 5s.
    const maxPositiveMs = 30_000;
    const negativeMs = 5_000;
    const entry = session
      ? { userId: session.userId, expiresAtMs: Math.min(nowMs + maxPositiveMs, session.expiresAt.getTime()) }
      : { userId: null, expiresAtMs: nowMs + negativeMs };
    writeSessionTokenUserCache(tokenHash, entry, nowMs);
    return entry.userId;
  }

  protected async getTracker(req: Record<string, unknown>): Promise<string> {
    const token = getSessionCookie(req as { cookies?: Record<string, string | undefined> });
    if (token) {
      const userId = await this.userIdFromSessionToken(token.trim());
      if (userId) return `user:${userId}`;
      // If token is invalid/expired, treat as unauthenticated and fall back to IP.
    }

    // Fall back to default behavior (typically uses req.ip)
    return super.getTracker(req);
  }
}

