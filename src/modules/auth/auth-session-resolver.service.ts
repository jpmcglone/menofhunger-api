import { Injectable } from '@nestjs/common';
import { AppConfigService } from '../app/app-config.service';
import { CacheInvalidationService } from '../redis/cache-invalidation.service';
import { PostsReadService } from '../posts-read/posts-read.service';
import { PresenceService } from '../presence/presence.service';
import { PrismaService } from '../prisma/prisma.service';
import { RedisService } from '../redis/redis.service';
import { RequestCacheService } from '../../common/cache/request-cache.service';
import { UnauthorizedException } from "@nestjs/common";
import {
  SESSION_RENEWAL_THRESHOLD_DAYS,
  SESSION_TTL_DAYS,
} from "./auth.constants";
import type { SessionResult } from './auth-session.types';
import { hmacSha256Hex } from "./auth.utils";
import { toUserDto } from "../../common/dto/user.dto";
import { RedisKeys } from "../redis/redis-keys";
import { USER_DTO_SELECT } from "../../common/prisma-selects/user.select";
import {
  dayIndexEastern,
  easternDayKey,
  easternDayKeyFromDayIndex,
} from "../../common/time/eastern-day-key";
import { NOT_DELETED } from '../../common/prisma/where';

export const SESSION_FULL_CACHE_TTL_MS = 30_000;

@Injectable()
export class AuthSessionResolverService {
  /** Process-level single-flight deduplication: concurrent requests with the same token share one promise. */
  private readonly inflightSessions = new Map<string, Promise<SessionResult | null>>();

  constructor(
    private readonly appConfig: AppConfigService,
    private readonly cacheInvalidation: CacheInvalidationService,
    private readonly postsRead: PostsReadService,
    private readonly presence: PresenceService,
    private readonly prisma: PrismaService,
    private readonly redis: RedisService,
    private readonly requestCache: RequestCacheService,
  ) {}

  async meFromSessionToken(token: string | undefined,
  ): Promise<SessionResult | null> {
    if (!token) return null;

    // Per-request memoization: the throttler guard and auth guard both resolve
    // the session cookie. Cache the result so the DB/Redis lookup happens at most once.
    const cacheKey = `auth:session:${token}`;
    const cached = this.requestCache.get<SessionResult | null>(cacheKey);
    if (cached !== undefined) return cached;

    // Process-level single-flight: if another concurrent request is already resolving
    // this token, share its promise instead of issuing a duplicate DB/Redis lookup.
    let pending = this.inflightSessions.get(token);
    if (!pending) {
      pending = this.resolveSession(token).finally(() => {
        this.inflightSessions.delete(token);
      });
      this.inflightSessions.set(token, pending);
    }

    const result = await pending;
    this.requestCache.set(cacheKey, result);

    // Pre-warm ViewerContextService's per-request cache so downstream getViewer() calls
    // are free Map lookups for the rest of this request — no extra DB round-trip.
    if (result) {
      this.requestCache.set(`viewerContext:${result.user.id}`, {
        id: result.user.id,
        verifiedStatus: result.user.verifiedStatus,
        premium: result.user.premium,
        premiumPlus: result.user.premiumPlus,
        siteAdmin: result.user.siteAdmin,
        bannedAt: result.user.bannedAt ? new Date(result.user.bannedAt) : null,
      });
      // Keep presence timestamps fresh for HTTP-only sessions (e.g. mid-onboarding before socket
      // connects). Throttled to 1× per 2 min so it's safe to call on every authenticated request.
      // Skipped under impersonation: an admin browsing someone's account must not make that
      // account look active to everyone else.
      if (!result.impersonatedByUserId)
        this.presence.markSeenFromHttp(result.user.id);
    }

    return result;
  }

  private async resolveSession(token: string,
  ): Promise<SessionResult | null> {
    const now = new Date();
    const tokenHash = hmacSha256Hex(this.appConfig.sessionHmacSecret(), token);

    // Fast path: check Redis cache before hitting the DB.
    try {
      const cached = await this.redis.getJson<{
        user: ReturnType<typeof toUserDto>;
        sessionId: string;
        expiresAt: string;
        impersonatedByUserId?: string | null;
        operatedByUserId?: string | null;
      }>(RedisKeys.sessionFull(tokenHash));
      if (cached) {
        return {
          user: cached.user,
          sessionId: cached.sessionId,
          expiresAt: new Date(cached.expiresAt),
          renewed: false,
          impersonatedByUserId: cached.impersonatedByUserId ?? null,
          operatedByUserId: cached.operatedByUserId ?? null,
        };
      }
    } catch {
      // Redis unavailable — fall through to DB.
    }

    const session = await this.prisma.session.findFirst({
      where: {
        tokenHash,
        revokedAt: null,
        expiresAt: { gt: now },
      },
      include: { user: { select: USER_DTO_SELECT } },
    });

    if (!session) return null;

    // Account state: banned users are logged out immediately and cannot use the app.
    if (session.user.bannedAt) {
      await this.revokeSessionToken(token);
      throw new UnauthorizedException({
        message:
          "This account was banned. Contact an admin if you think it’s a mistake.",
        error: "account_banned",
      });
    }

    // Sliding-window renewal: push expiresAt out by SESSION_TTL_DAYS whenever
    // the session is within SESSION_RENEWAL_THRESHOLD_DAYS of expiring. This
    // keeps active users logged in indefinitely without requiring a re-login.
    const renewalThresholdMs = SESSION_RENEWAL_THRESHOLD_DAYS * 24 * 60 * 60_000;
    const timeUntilExpiryMs = session.expiresAt.getTime() - now.getTime();
    let renewed = false;
    let effectiveExpiresAt = session.expiresAt;

    // Impersonation sessions are deliberately excluded: they must die at their short fixed
    // expiry instead of extending themselves for as long as the admin keeps a tab open.
    if (!session.impersonatedByUserId && timeUntilExpiryMs < renewalThresholdMs) {
      effectiveExpiresAt = new Date(
        now.getTime() + SESSION_TTL_DAYS * 24 * 60 * 60_000,
      );
      try {
        await this.prisma.session.update({
          where: { id: session.id },
          data: { expiresAt: effectiveExpiresAt },
        });
        renewed = true;
      } catch {
        // Best-effort — if the update fails the session is still valid until original expiry.
      }
    }

    const user = toUserDto(
      session.user,
      this.appConfig.r2()?.publicBaseUrl ?? null,
    );

    // Cache the result so subsequent guard calls within the TTL window skip the DB.
    // On cache hit we always return renewed: false (renewal already happened above).
    const ttlMs = Math.max(
      1,
      Math.min(
        SESSION_FULL_CACHE_TTL_MS,
        effectiveExpiresAt.getTime() - now.getTime(),
      ),
    );
    void this.redis
      .setJson(
        RedisKeys.sessionFull(tokenHash),
        {
          user,
          sessionId: session.id,
          expiresAt: effectiveExpiresAt.toISOString(),
          impersonatedByUserId: session.impersonatedByUserId,
          operatedByUserId: session.operatedByUserId,
        },
        { ttlMs },
      )
      .catch(() => undefined);

    return {
      user,
      sessionId: session.id,
      expiresAt: effectiveExpiresAt,
      renewed,
      impersonatedByUserId: session.impersonatedByUserId,
      operatedByUserId: session.operatedByUserId ?? null,
    };
  }

  async runMeChecks(token: string,
    userId: string,
    pinnedPostId: string | null,
    userObj: ReturnType<typeof toUserDto>,
  ): Promise<ReturnType<typeof toUserDto>> {
    const throttleKey = RedisKeys.meChecksThrottle(userId);
    try {
      const throttled = await this.redis.getString(throttleKey);
      if (throttled) return userObj;
    } catch {
      // Redis unavailable — fall through and run checks.
    }

    const now = new Date();
    const tokenHash = hmacSha256Hex(this.appConfig.sessionHmacSecret(), token);
    let changed = false;

    // Safety: only-me posts should never be pinnable/show on profiles.
    // If a user already pinned an only-me post (legacy bug), auto-unpin on read.
    if (pinnedPostId) {
      const pinned = await this.postsRead.findFirst({
        where: { id: pinnedPostId, userId, ...NOT_DELETED },
        select: { visibility: true },
      });
      if (!pinned || pinned.visibility === "onlyMe") {
        await this.prisma.user.update({
          where: { id: userId },
          data: { pinnedPostId: null },
        });
        userObj.pinnedPostId = null;
        changed = true;
      }
    }

    // Self-heal: streak day key bugs can leave `checkinStreakDays` undercounted even though today's award happened.
    // We only ever adjust upward, and never touch coins here.
    try {
      const todayKey = easternDayKey(now);
      const currentStreak = Math.max(
        0,
        Math.floor(userObj.checkinStreakDays ?? 0),
      );
      const lastKey =
        String(userObj.lastCheckinDayKey ?? "").trim() || null;
      // Only run on a suspicious "awarded today but streak=1" state.
      if (lastKey === todayKey && currentStreak === 1) {
        const since = new Date(now.getTime() - 45 * 24 * 60 * 60 * 1000);
        const rows = await this.postsRead.findMany({
          where: {
            userId,
            kind: "checkin",
            ...NOT_DELETED,
            visibility: { not: "onlyMe" },
            createdAt: { gte: since },
          },
          select: { createdAt: true, checkinDayKey: true },
          orderBy: { createdAt: "desc" },
          take: 400,
        });
        const daySet = new Set<string>();
        for (const r of rows) {
          const key =
            r.checkinDayKey || (r?.createdAt ? easternDayKey(r.createdAt) : "");
          if (key) daySet.add(key);
        }
        const todayIndex = dayIndexEastern(now);
        let streak = 0;
        for (let i = 0; i < 120; i += 1) {
          const key = easternDayKeyFromDayIndex(todayIndex - i);
          if (!daySet.has(key)) break;
          streak += 1;
        }
        if (streak > currentStreak) {
          const nextLongest = Math.max(
            Math.max(0, Math.floor(userObj.longestStreakDays ?? 0)),
            streak,
          );
          await this.prisma.user.update({
            where: { id: userId },
            data: { checkinStreakDays: streak, longestStreakDays: nextLongest },
          });
          userObj.checkinStreakDays = streak;
          userObj.longestStreakDays = nextLongest;
          changed = true;
        }
      }
    } catch {
      // Best-effort only; never block auth/me.
    }

    // If user data changed, bust the session cache so guards see fresh data on next request.
    if (changed) {
      void this.cacheInvalidation
        .deleteSessionFull(tokenHash)
        .catch(() => undefined);
    }

    // Mark checks as done for this user; skip for the next 2 minutes.
    void this.redis
      .setString(throttleKey, "1", { ttlMs: 2 * 60_000 })
      .catch(() => undefined);

    return userObj;
  }

  /**
   * Soft-revoke a session token server-side without touching cookies.
   * Sets `revokedAt` instead of deleting so the row remains as an audit trail
   * until the cleanup cron removes it after the retention window.
   * Useful for non-HTTP contexts like WebSocket logout.
   */
  async revokeSessionToken(token: string | undefined): Promise<void> {
    if (!token) return;
    const tokenHash = hmacSha256Hex(this.appConfig.sessionHmacSecret(), token);
    // Remove Redis-backed session caches immediately to avoid a short stale-valid window.
    await Promise.allSettled([
      this.cacheInvalidation.deleteSessionUser(tokenHash),
      this.cacheInvalidation.deleteSessionFull(tokenHash),
    ]);
    await this.prisma.session.updateMany({
      where: { tokenHash, revokedAt: null },
      data: { revokedAt: new Date() },
    });
  }
}



