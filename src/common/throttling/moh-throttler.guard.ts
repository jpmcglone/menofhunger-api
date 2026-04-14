import { Injectable } from '@nestjs/common';
import { ThrottlerGuard } from '@nestjs/throttler';
import { Reflector } from '@nestjs/core';
import {
  InjectThrottlerOptions,
  InjectThrottlerStorage,
} from '@nestjs/throttler/dist/throttler.decorator';
import type { ThrottlerModuleOptions } from '@nestjs/throttler/dist/throttler-module-options.interface';
import type { ThrottlerStorage } from '@nestjs/throttler/dist/throttler-storage.interface';
import { getSessionCookie } from '../session-cookie';
import { AuthService } from '../../modules/auth/auth.service';

/**
 * Throttling key strategy:
 * - If the request has a valid session cookie, throttle by user id (shared across sessions).
 * - Otherwise throttle by IP.
 *
 * Delegates session resolution to AuthService.meFromSessionToken which memoizes
 * the result per-request via RequestCacheService. This means when the route-level
 * AuthGuard / OptionalAuthGuard calls the same method later, it's a free cache hit
 * instead of a second Redis+DB round-trip.
 */
@Injectable()
export class MohThrottlerGuard extends ThrottlerGuard {
  constructor(
    @InjectThrottlerOptions() options: ThrottlerModuleOptions,
    @InjectThrottlerStorage() storageService: ThrottlerStorage,
    reflector: Reflector,
    private readonly auth: AuthService,
  ) {
    super(options, storageService, reflector);
  }

  protected async getTracker(req: Record<string, unknown>): Promise<string> {
    const token = getSessionCookie(req as { cookies?: Record<string, string | undefined> });
    if (token) {
      try {
        const session = await this.auth.meFromSessionToken(token.trim());
        if (session) return `user:${session.user.id}`;
      } catch {
        // Banned / revoked — fall through to IP-based throttling.
      }
    }

    return super.getTracker(req);
  }
}

