import { BadRequestException, Inject, Injectable, Logger, ServiceUnavailableException, UnauthorizedException } from '@nestjs/common';
import type { Response } from 'express';
import { PrismaService } from '../prisma/prisma.service';
import { AppConfigService } from '../app/app-config.service';
import {
  AUTH_COOKIE_NAME,
  OTP_RESEND_SECONDS,
  SESSION_RENEWAL_THRESHOLD_DAYS,
  SESSION_TTL_DAYS,
} from './auth.constants';
import { hmacSha256Hex, randomSessionToken } from './auth.utils';
import { OTP_PROVIDER } from './otp/otp-provider.token';
import type { OtpProvider } from './otp/otp-provider';
import { toUserDto } from '../users/user.dto';
import { CacheInvalidationService } from '../redis/cache-invalidation.service';
import { RedisService } from '../redis/redis.service';
import { RedisKeys } from '../redis/redis-keys';
import { USER_DTO_SELECT } from '../../common/prisma-selects/user.select';
import { dayIndexEastern, easternDayKey, easternDayKeyFromDayIndex } from '../../common/time/eastern-day-key';
import { PosthogService } from '../../common/posthog/posthog.service';
import { SlackService } from '../../common/slack/slack.service';
import { RequestCacheService } from '../../common/cache/request-cache.service';

/** TTL for the full session cache (auth guards). Short enough to pick up bans/revocations quickly. */
const SESSION_FULL_CACHE_TTL_MS = 30_000;

export interface SessionResult {
  user: ReturnType<typeof toUserDto>;
  sessionId: string;
  expiresAt: Date;
  renewed: boolean;
}

@Injectable()
export class AuthService {
  private readonly logger = new Logger(AuthService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly appConfig: AppConfigService,
    private readonly cacheInvalidation: CacheInvalidationService,
    private readonly redis: RedisService,
    @Inject(OTP_PROVIDER) private readonly otpProvider: OtpProvider,
    private readonly posthog: PosthogService,
    private readonly slack: SlackService,
    private readonly requestCache: RequestCacheService,
  ) {}

  private maskPhone(phone: string) {
    const digits = phone.replace(/\D/g, '');
    const last2 = digits.slice(-2);
    return digits.length >= 2 ? `***${last2}` : '***';
  }

  async startPhoneAuth(phone: string) {
    const now = new Date();

    const latest = await this.prisma.phoneOtp.findFirst({
      where: { phone },
      orderBy: { createdAt: 'desc' },
    });

    if (latest?.resendAfterAt && latest.resendAfterAt > now) {
      const retryAfterSeconds = Math.max(
        1,
        Math.ceil((latest.resendAfterAt.getTime() - now.getTime()) / 1000),
      );
      return { retryAfterSeconds };
    }

    const isProd = this.appConfig.isProd();
    const disableTwilioInDev = !isProd && this.appConfig.disableTwilioInDev();
    const hasTwilioVerify = Boolean(this.appConfig.twilioVerify());
    const existing = await this.prisma.user.findUnique({
      where: { phone },
      select: { bannedAt: true },
    });
    const isBanned = Boolean(existing?.bannedAt);

    this.logger.log(
      `startPhoneAuth phone=${this.maskPhone(phone)} env=${this.appConfig.nodeEnv()} twilio=${
        disableTwilioInDev ? 'disabled_in_dev' : hasTwilioVerify ? 'verify_enabled' : 'not_configured'
      }`,
    );

    if (isProd && !hasTwilioVerify) {
      throw new ServiceUnavailableException('SMS login is not configured yet. Please try again later.');
    }

    // Abuse-prevention: banned accounts should never trigger an OTP send.
    if (!disableTwilioInDev && hasTwilioVerify && !isBanned) {
      try {
        await this.otpProvider.start(phone);
      } catch (err) {
        this.logger.error(`Twilio Verify start failed for phone=${this.maskPhone(phone)}`, (err as Error)?.stack);
        throw new ServiceUnavailableException('SMS login is not configured yet. Please try again later.');
      }
    } else {
      this.logger.warn(
        `Skipping SMS send for phone=${this.maskPhone(phone)}${
          isBanned ? ' reason=banned' : ''
        }`,
      );
    }

    // Store a row to enforce resend cooldown and represent "an active code exists".
    // We don't store/know the Verify code, so hash a random value.
    const codeHash = hmacSha256Hex(this.appConfig.otpHmacSecret(), `${phone}:${randomSessionToken()}`);
    const expiresAt = new Date(now.getTime() + 10 * 60_000);
    const resendAfterAt = new Date(now.getTime() + OTP_RESEND_SECONDS * 1000);

    await this.prisma.phoneOtp.create({
      data: {
        phone,
        codeHash,
        expiresAt,
        resendAfterAt,
      },
    });

    return { retryAfterSeconds: OTP_RESEND_SECONDS };
  }

  async phoneExists(phone: string): Promise<boolean> {
    const existing = await this.prisma.user.findUnique({
      where: { phone },
      select: { id: true },
    });
    return Boolean(existing);
  }

  async verifyPhoneCode(phone: string, code: string, res: Response, referralCode?: string | null) {
    const now = new Date();
    const isProd = this.appConfig.isProd();
    const disableTwilioInDev = !isProd && this.appConfig.disableTwilioInDev();
    const hasTwilioVerify = Boolean(this.appConfig.twilioVerify());

    const isDevBypass = !isProd && code === '000000';

    // Account state: reveal bans only after code submit (not during /start).
    // Also: do this *before* OTP checks so banned accounts don't require a started OTP.
    const existing = await this.prisma.user.findUnique({ where: { phone } });
    const isNewUser = !existing;
    if (existing?.bannedAt) {
      throw new UnauthorizedException({
        message: 'This account was banned. Contact an admin if you think it’s a mistake.',
        error: 'account_banned',
      });
    }

    // In dev, allow bypass even if /auth/phone/start was never called.
    // (Still safe: production does not allow this path.)
    const otp = await this.prisma.phoneOtp.findFirst({
      where: {
        phone,
        consumedAt: null,
        expiresAt: { gt: now },
      },
      orderBy: { createdAt: 'desc' },
    });

    if (!otp && !isDevBypass) {
      throw new BadRequestException('No active code found. Please resend.');
    }

    if (!isDevBypass) {
      if (!disableTwilioInDev && hasTwilioVerify) {
        try {
          const ok = await this.otpProvider.check(phone, code);
          if (!ok) throw new BadRequestException('Invalid code. Please try again.');
        } catch (err) {
          if (err instanceof BadRequestException) throw err;
          this.logger.error(`Twilio Verify check failed for phone=${this.maskPhone(phone)}`, (err as Error)?.stack);
          throw new ServiceUnavailableException('SMS login is not configured yet. Please try again later.');
        }
      } else {
        throw new ServiceUnavailableException('SMS login is not configured yet. Please try again later.');
      }
    }

    if (otp) {
      await this.prisma.phoneOtp.update({
        where: { id: otp.id },
        data: { consumedAt: now },
      });
    }

    // Resolve recruiter from referral code (only for new users; silently ignore invalid codes).
    let recruitedById: string | null = null;
    if (isNewUser && referralCode) {
      try {
        const recruiter = await this.prisma.user.findFirst({
          where: { referralCode: referralCode.trim().toUpperCase() },
          select: { id: true, premium: true },
        });
        if (recruiter && recruiter.premium) {
          recruitedById = recruiter.id;
        }
      } catch {
        // Best-effort — never block signup over a bad code.
      }
    }

    const user = existing
      ? existing
      : await this.prisma.user.create({
          data: {
            phone,
            username: null,
            usernameIsSet: false,
            ...(recruitedById ? { recruitedById } : {}),
          },
        });

    // Auto-follow the recruiter on signup so the new user's feed is populated immediately.
    if (isNewUser && recruitedById) {
      try {
        await this.prisma.follow.create({
          data: { followerId: user.id, followingId: recruitedById },
        });
      } catch {
        // Idempotent — ignore duplicates or any transient error; never block signup.
      }
    }

    const session = await this.createSessionAndSetCookie(user.id, res);

    if (isNewUser) {
      this.posthog.capture(user.id, 'user_signed_up', { phone_masked: this.maskPhone(phone) });
      this.slack.notifySignup({ userId: user.id });
    } else {
      this.posthog.capture(user.id, 'user_login');
    }

    const publicBaseUrl = this.appConfig.r2()?.publicBaseUrl ?? null;
    return {
      isNewUser,
      referralApplied: Boolean(isNewUser && recruitedById),
      user: toUserDto(user, publicBaseUrl),
      sessionId: session.id,
    };
  }

  async meFromSessionToken(token: string | undefined): Promise<SessionResult | null> {
    if (!token) return null;

    // Per-request memoization: the throttler guard and auth guard both resolve
    // the session cookie. Cache the result so the DB/Redis lookup happens at most once.
    const cacheKey = `auth:session:${token}`;
    const cached = this.requestCache.get<SessionResult | null>(cacheKey);
    if (cached !== undefined) return cached;

    const result = await this._resolveSession(token);
    this.requestCache.set(cacheKey, result);
    return result;
  }

  private async _resolveSession(token: string): Promise<SessionResult | null> {
    const now = new Date();
    const tokenHash = hmacSha256Hex(this.appConfig.sessionHmacSecret(), token);

    // Fast path: check Redis cache before hitting the DB.
    try {
      const cached = await this.redis.getJson<{ user: ReturnType<typeof toUserDto>; sessionId: string; expiresAt: string }>(
        RedisKeys.sessionFull(tokenHash),
      );
      if (cached) {
        return { user: cached.user, sessionId: cached.sessionId, expiresAt: new Date(cached.expiresAt), renewed: false };
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
        message: 'This account was banned. Contact an admin if you think it’s a mistake.',
        error: 'account_banned',
      });
    }

    // Sliding-window renewal: push expiresAt out by SESSION_TTL_DAYS whenever
    // the session is within SESSION_RENEWAL_THRESHOLD_DAYS of expiring. This
    // keeps active users logged in indefinitely without requiring a re-login.
    const renewalThresholdMs = SESSION_RENEWAL_THRESHOLD_DAYS * 24 * 60 * 60_000;
    const timeUntilExpiryMs = session.expiresAt.getTime() - now.getTime();
    let renewed = false;
    let effectiveExpiresAt = session.expiresAt;

    if (timeUntilExpiryMs < renewalThresholdMs) {
      effectiveExpiresAt = new Date(now.getTime() + SESSION_TTL_DAYS * 24 * 60 * 60_000);
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

    const user = toUserDto(session.user, this.appConfig.r2()?.publicBaseUrl ?? null);

    // Cache the result so subsequent guard calls within the TTL window skip the DB.
    // On cache hit we always return renewed: false (renewal already happened above).
    const ttlMs = Math.max(1, Math.min(SESSION_FULL_CACHE_TTL_MS, effectiveExpiresAt.getTime() - now.getTime()));
    void this.redis
      .setJson(RedisKeys.sessionFull(tokenHash), { user, sessionId: session.id, expiresAt: effectiveExpiresAt.toISOString() }, { ttlMs })
      .catch(() => undefined);

    return { user, sessionId: session.id, expiresAt: effectiveExpiresAt, renewed };
  }

  /**
   * Run expensive per-request checks that are only needed for GET /auth/me.
   * Kept out of meFromSessionToken so the auth guards do not pay this cost.
   * Mutates and returns an updated user object when corrections are made.
   *
   * Throttled to at most once per ME_CHECKS_THROTTLE_MS via a Redis key so
   * repeated /auth/me polls (badge refresh, tab focus) skip the DB round-trips.
   */
  async runMeChecks(
    token: string,
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
      const pinned = await this.prisma.post.findFirst({
        where: { id: pinnedPostId, userId, deletedAt: null },
        select: { visibility: true },
      });
      if (!pinned || pinned.visibility === 'onlyMe') {
        await this.prisma.user.update({ where: { id: userId }, data: { pinnedPostId: null } });
        (userObj as any).pinnedPostId = null;
        changed = true;
      }
    }

    // Self-heal: streak day key bugs can leave `checkinStreakDays` undercounted even though today's award happened.
    // We only ever adjust upward, and never touch coins here.
    try {
      const todayKey = easternDayKey(now);
      const currentStreak = Math.max(0, Math.floor((userObj as any).checkinStreakDays ?? 0));
      const lastKey = String((userObj as any).lastCheckinDayKey ?? '').trim() || null;
      // Only run on a suspicious "awarded today but streak=1" state.
      if (lastKey === todayKey && currentStreak === 1) {
        const since = new Date(now.getTime() - 45 * 24 * 60 * 60 * 1000);
        const rows = await this.prisma.post.findMany({
          where: {
            userId,
            deletedAt: null,
            visibility: { not: 'onlyMe' },
            createdAt: { gte: since },
          },
          select: { createdAt: true },
          orderBy: { createdAt: 'desc' },
          take: 400,
        });
        const daySet = new Set<string>();
        for (const r of rows) {
          if (r?.createdAt) daySet.add(easternDayKey(r.createdAt));
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
            Math.max(0, Math.floor((userObj as any).longestStreakDays ?? 0)),
            streak,
          );
          await this.prisma.user.update({
            where: { id: userId },
            data: { checkinStreakDays: streak, longestStreakDays: nextLongest },
          });
          (userObj as any).checkinStreakDays = streak;
          (userObj as any).longestStreakDays = nextLongest;
          changed = true;
        }
      }
    } catch {
      // Best-effort only; never block auth/me.
    }

    // If user data changed, bust the session cache so guards see fresh data on next request.
    if (changed) {
      void this.cacheInvalidation.deleteSessionFull(tokenHash).catch(() => undefined);
    }

    // Mark checks as done for this user; skip for the next 2 minutes.
    void this.redis.setString(throttleKey, '1', { ttlMs: 2 * 60_000 }).catch(() => undefined);

    return userObj;
  }

  async revokeAllSessionsForUser(userId: string): Promise<void> {
    const id = String(userId ?? '').trim();
    if (!id) return;
    const sessions = await this.prisma.session.findMany({
      where: { userId: id },
      select: { tokenHash: true },
    });
    // Drop cached session->user lookups immediately (best-effort).
    for (const s of sessions) {
      const th = String(s.tokenHash ?? '').trim();
      if (!th) continue;
      await Promise.allSettled([
        this.cacheInvalidation.deleteSessionUser(th),
        this.cacheInvalidation.deleteSessionFull(th),
      ]);
    }
    await this.prisma.session.deleteMany({ where: { userId: id } });
  }

  async logout(token: string | undefined, res: Response) {
    await this.revokeSessionToken(token);

    this.clearAuthCookie(res);
    return { success: true };
  }

  /**
   * Revoke (delete) a session token server-side without touching cookies.
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
    await this.prisma.session.deleteMany({
      where: { tokenHash },
    });
  }

  private cookieOptions(expires: Date) {
    const isProd = this.appConfig.isProd();
    const domain = isProd ? this.appConfig.cookieDomain() ?? '.menofhunger.com' : undefined;
    return {
      httpOnly: true,
      secure: isProd,
      sameSite: 'lax' as const,
      domain,
      path: '/',
      expires,
    };
  }

  setSessionCookie(token: string, expires: Date, res: Response) {
    res.cookie(AUTH_COOKIE_NAME, token, this.cookieOptions(expires));
  }

  private clearAuthCookie(res: Response) {
    const isProd = this.appConfig.isProd();
    const domain = isProd ? this.appConfig.cookieDomain() ?? '.menofhunger.com' : undefined;
    res.clearCookie(AUTH_COOKIE_NAME, { path: '/', domain });
  }

  private async createSessionAndSetCookie(userId: string, res: Response) {
    const token = randomSessionToken();
    const tokenHash = hmacSha256Hex(this.appConfig.sessionHmacSecret(), token);

    const now = new Date();
    const expiresAt = new Date(now.getTime() + SESSION_TTL_DAYS * 24 * 60 * 60_000);

    const session = await this.prisma.session.create({
      data: { userId, tokenHash, expiresAt },
    });

    this.setSessionCookie(token, expiresAt, res);
    return session;
  }
}

