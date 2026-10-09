import { isUniqueViolation } from '../../common/prisma/errors';
import { errorFields } from '../../common/errors/error-fields';
import { NOT_BANNED_USER_WHERE } from '../../common/prisma-selects/user.where';
import { ACCOUNT_DELETION_PENDING_REASON } from './account-deletion.constants';
import { BadRequestException, ForbiddenException, Inject, Injectable, InternalServerErrorException, Logger, ServiceUnavailableException, UnauthorizedException } from '@nestjs/common';
import type { Response } from 'express';
import { Prisma, type User } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { AppConfigService } from '../app/app-config.service';
import { AFFILIATE_RATES_CENTS, AFFILIATE_CAP_CENTS } from '../billing/affiliate.constants';
import { AUTH_COOKIE_NAME, IMPERSONATION_SESSION_TTL_MINUTES, OTP_RESEND_SECONDS, SESSION_TTL_DAYS } from './auth.constants';
import { hmacSha256Hex, randomSessionToken } from './auth.utils';
import { resolveSignupAttribution, type SignupAttribution, type SignupAttributionInput } from './signup-attribution';
import { OTP_PROVIDER } from './otp/otp-provider.token';
import type { OtpProvider } from './otp/otp-provider';
import { toUserDto } from '../../common/dto/user.dto';
import { CacheInvalidationService } from '../redis/cache-invalidation.service';
import { RedisService } from '../redis/redis.service';
import { PosthogService } from '../../common/posthog/posthog.service';
import { SlackService } from '../../common/slack/slack.service';
import { PresenceService } from '../presence/presence.service';
import { PresenceRealtimeService } from '../presence/presence-realtime.service';
import { SideEffectsService } from '../side-effects/side-effects.service';

import { AuthSessionResolverService } from './auth-session-resolver.service';
import type { SessionResult } from './auth-session.types';
/** TTL for the full session cache (auth guards). Short enough to pick up bans/revocations quickly. */

/**
 * Translate a Twilio Verify API error into a user-facing message.
 *
 * Common Twilio Verify error codes:
 *   60082 – Geographic permission not enabled for this destination.
 *   60033 – Invalid phone number for this region.
 *   60034 – Invalid destination country.
 *   60083 – Carrier blocked the message.
 *   21211 – Invalid 'To' phone number (malformed E.164).
 *   21614 – Not a valid mobile number.
 *   21612 – Destination not reachable via SMS.
 *
 * When none of these match we fall back to a generic retry message so we
 * don't accidentally leak internal details.
 */
function twilioUserMessage(err: unknown): string {
  const code = typeof errorFields(err).code === 'number' ? errorFields(err).code as number : null;
  if (code === 60082 || code === 60033 || code === 60034) {
    return 'SMS is not available for this phone number or region. Double-check your country code and number, or contact support.';
  }
  if (code === 60083 || code === 21612) {
    return 'Your carrier blocked the verification message. Please try a different number or contact support.';
  }
  if (code === 21211 || code === 21614) {
    return 'That doesn\'t look like a valid mobile number. For international numbers include your country code (e.g. +44 7911 123456).';
  }
  return 'Failed to send the verification code. Please try again in a moment.';
}

function twilioLogDetails(err: unknown): string {
  const { code, status, message } = errorFields(err);
  return `twilioCode=${code ?? 'unknown'} httpStatus=${status ?? 'unknown'} msg="${message ?? ''}"`;
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
    private readonly presence: PresenceService,
    private readonly presenceRealtime: PresenceRealtimeService,
    private readonly sideEffects: SideEffectsService,
    private readonly sessions: AuthSessionResolverService,
  ) {}

  private maskPhone(phone: string) {
    const digits = phone.replace(/\D/g, '');
    const last2 = digits.slice(-2);
    return digits.length >= 2 ? `***${last2}` : '***';
  }

  private async assertPhoneNotParked(phone: string, now = new Date()) {
    const parked = await this.prisma.parkedPhone?.findUnique({
      where: { phone },
      select: { releaseAt: true },
    });
    if (parked && parked.releaseAt > now) {
      throw new BadRequestException(
        'This number is reserved after an account transfer. Try again later or contact support.',
      );
    }
  }

  async startPhoneAuth(phone: string) {
    const now = new Date();
    await this.assertPhoneNotParked(phone, now);

    const latest = await this.prisma.phoneOtp.findFirst({
      where: { phone },
      orderBy: { createdAt: 'desc' },
    });

    if (latest?.resendAfterAt && latest.resendAfterAt > now) {
      const retryAfterSeconds = Math.max(
        1,
        Math.ceil((latest.resendAfterAt.getTime() - now.getTime()) / 1000),
      );
      // No new SMS goes out here — there's already an active code for this phone
      // (e.g. the user just requested one from another device/tab/app a moment ago).
      // `sent: false` lets the client tell the user to check for the code they
      // already have instead of implying a fresh text is on its way.
      return { sent: false, retryAfterSeconds };
    }

    const isProd = this.appConfig.isProd();
    const disableTwilioInDev = !isProd && this.appConfig.disableTwilioInDev();
    const hasTwilioVerify = Boolean(this.appConfig.twilioVerify());
    const existing = await this.prisma.user.findUnique({
      where: { phone },
      select: { bannedAt: true, bannedReason: true, deletionScheduledAt: true },
    });
    const canRestorePendingDeletion = Boolean(
      existing?.bannedReason === ACCOUNT_DELETION_PENDING_REASON &&
        (!existing.deletionScheduledAt || existing.deletionScheduledAt > now),
    );
    const isBanned = Boolean(existing?.bannedAt && !canRestorePendingDeletion);

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
        this.logger.error(`Twilio Verify start failed for phone=${this.maskPhone(phone)} ${twilioLogDetails(err)}`, (err as Error)?.stack);
        throw new ServiceUnavailableException(twilioUserMessage(err));
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

    return { sent: true, retryAfterSeconds: OTP_RESEND_SECONDS };
  }

  async phoneExists(phone: string): Promise<boolean> {
    const [existing, parked] = await Promise.all([
      this.prisma.user.findUnique({
        where: { phone },
        select: { id: true },
      }),
      this.prisma.parkedPhone?.findUnique({
        where: { phone },
        select: { releaseAt: true },
      }),
    ]);
    if (existing) return true;
    return Boolean(parked && parked.releaseAt > new Date());
  }

  async verifyPhoneCode(phone: string, code: string, res: Response,
    referralCode?: string | null,
    attribution?: SignupAttributionInput,
  ) {
    const now = new Date();
    const isProd = this.appConfig.isProd();
    const disableTwilioInDev = !isProd && this.appConfig.disableTwilioInDev();
    const hasTwilioVerify = Boolean(this.appConfig.twilioVerify());

    const isDevBypass = !isProd && code === '000000';

    // App Review bypass: a single pre-configured phone+code pair that works in any environment.
    // Allows App Review to sign in without a live Twilio SMS. Only active when both env vars are set.
    const reviewCreds = this.appConfig.appReviewCredentials();
    const isReviewBypass = Boolean(
      reviewCreds && phone === reviewCreds.phone && code === reviewCreds.code,
    );
    const isBypass = isDevBypass || isReviewBypass;

    // Account state: reveal bans only after code submit (not during /start).
    // Also: do this *before* OTP checks so banned accounts don't require a started OTP.
    await this.assertPhoneNotParked(phone, now);

    const existing = await this.prisma.user.findUnique({ where: { phone } });
    const isNewUser = !existing;
    const canRestorePendingDeletion = Boolean(
      existing?.bannedReason === ACCOUNT_DELETION_PENDING_REASON &&
        (!existing.deletionScheduledAt || existing.deletionScheduledAt > now),
    );
    if (existing?.bannedAt && !canRestorePendingDeletion) {
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

    if (!otp && !isBypass) {
      throw new BadRequestException('No active code found. Please resend.');
    }

    if (!isBypass) {
      if (!disableTwilioInDev && hasTwilioVerify) {
        try {
          const ok = await this.otpProvider.check(phone, code);
          if (!ok) throw new BadRequestException('Invalid code. Please try again.');
        } catch (err) {
          if (err instanceof BadRequestException) throw err;
          this.logger.error(`Twilio Verify check failed for phone=${this.maskPhone(phone)} ${twilioLogDetails(err)}`, (err as Error)?.stack);
          throw new ServiceUnavailableException(twilioUserMessage(err));
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
          select: { id: true, verifiedStatus: true },
        });
        // Code owners must be verified (identity or manual) to be valid recruiters.
        if (recruiter && recruiter.verifiedStatus !== 'none') {
          recruitedById = recruiter.id;
        }
      } catch {
        // Best-effort — never block signup over a bad code.
      }
    }

    const restoredPendingDeletion = canRestorePendingDeletion;
    const signupAttribution = isNewUser
      ? resolveSignupAttribution(attribution, { referralApplied: Boolean(recruitedById) })
      : null;
    const user = await this.resolveVerifiedUser({
      phone,
      existing,
      restoredPendingDeletion,
      now,
      recruitedById,
      signupAttribution,
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

      // Record affiliate cash earning for the signup milestone (best-effort; idempotent).
      // Qualification: recruit signed up after affiliateAt (inherently true here — this is signup itself).
      try {
        const recruiter = await this.prisma.user.findUnique({
          where: { id: recruitedById },
          select: { affiliateAt: true },
        });
        if (recruiter?.affiliateAt) {
          // Cap check: skip if adding signup earning would exceed per-member cap.
          const capCheck = await this.prisma.affiliateEarning.aggregate({
            where: { affiliateUserId: recruitedById },
            _sum: { amountCents: true },
          });
          const currentTotal = capCheck._sum.amountCents ?? 0;
          if (currentTotal + AFFILIATE_RATES_CENTS.signup <= AFFILIATE_CAP_CENTS) {
            await this.prisma.affiliateEarning.create({
              data: {
                affiliateUserId: recruitedById,
                recruitUserId: user.id,
                type: 'signup',
                amountCents: AFFILIATE_RATES_CENTS.signup,
              },
            });
            this.presenceRealtime.emitReferralRecruitUpdated(recruitedById, {
              recruit: {
                id: user.id,
                username: user.username ?? null,
                name: user.name ?? null,
                premium: false,
                premiumPlus: false,
                isOrganization: false,
                verifiedStatus: 'none',
                avatarUrl: null,
                orgAffiliations: [],
                recruitedAt: user.createdAt.toISOString(),
                isVerified: false,
                isPremium: false,
                bonusGranted: false,
              },
            });
          } else {
            this.logger.log(`[affiliate] Cap reached for affiliate=${recruitedById}: skipping signup earning`);
          }
        }
      } catch (err: unknown) {
        if (!isUniqueViolation(err)) {
          this.logger.warn(`[affiliate] Failed to record signup earning for recruit=${user.id}: ${err}`);
        }
      }
    }

    const session = await this.createSessionForUser(user.id, res);

    // Fire-and-forget: update presence so the user appears in "recently around"
    // even if they never open a WebSocket (e.g. mobile sign-up, abandoned onboarding).
    this.presence.markSeenFromHttp(user.id);

    if (isNewUser) {
      this.posthog.capture(user.id, 'user_signed_up', {
        signup_source: user.signupSource ?? null,
        signup_campaign: user.signupCampaign ?? null,
      });
      this.slack.notifySignup({ userId: user.id });

      // Auto-verify (coins, affiliate earnings, billing hooks) never blocks a signup.
      this.sideEffects.dispatch('user.auto-verify', {
        userId: user.id,
        recruitedById,
        source: 'auto_signup',
      });
    } else if (restoredPendingDeletion) {
      this.posthog.capture(user.id, 'account_deletion_cancelled');
    } else {
      this.posthog.capture(user.id, 'user_login');
    }

    const publicBaseUrl = this.appConfig.r2()?.publicBaseUrl ?? null;
    return {
      isNewUser,
      referralApplied: Boolean(isNewUser && recruitedById),
      accountDeletionCancelled: restoredPendingDeletion,
      user: toUserDto(user, publicBaseUrl),
      sessionId: session.id,
    };
  }

  /**
   * Creates, restores, or reuses the User row for a verified phone number.
   *
   * Wrapped separately (rather than inline in `verifyPhoneCode`) so we can give
   * a clear diagnostic log + a typed error instead of letting a raw Prisma
   * exception bubble up as an opaque 500. Also self-heals the `existing: null`
   * + concurrent-signup race (two verify calls for the same number landing at
   * once — e.g. a double-tap or app + web both mid-signup) by treating a
   * unique-constraint violation on `phone` as "someone else just created this
   * user a moment ago" and re-reading it instead of failing the request.
   */
  private async resolveVerifiedUser(params: {
    phone: string;
    existing: User | null;
    restoredPendingDeletion: boolean;
    now: Date;
    recruitedById: string | null;
    signupAttribution: SignupAttribution | null;
  }): Promise<User> {
    const { phone, existing, restoredPendingDeletion, now, recruitedById, signupAttribution } = params;

    if (existing) {
      if (!restoredPendingDeletion) return existing;
      try {
        return await this.prisma.$transaction(async tx => {
          const restored = await tx.user.updateMany({
            where: { id: existing.id, bannedReason: ACCOUNT_DELETION_PENDING_REASON, deletionScheduledAt: { gt: now } },
            data: { ...NOT_BANNED_USER_WHERE, bannedReason: null, deletionRequestedAt: null, deletionScheduledAt: null },
          });
          if (!restored.count) throw new ForbiddenException('Account deletion has already started.');
          await tx.accountDeletionReceipt.updateMany({ where: { userId: existing.id, startedAt: null },
            data: { cancelledAt: now, userId: null, confirmationEmail: null } });
          return tx.user.findUniqueOrThrow({ where: { id: existing.id } });
        });
      } catch (err) {
        if (err instanceof ForbiddenException) throw err;
        this.logger.error(
          `Failed to restore pending-deletion account for phone=${this.maskPhone(phone)}: ${(err as Error)?.message}`,
          (err as Error)?.stack,
        );
        throw new InternalServerErrorException('Could not restore your account. Please try again or contact support.');
      }
    }

    try {
      return await this.prisma.user.create({
        data: {
          phone,
          username: null,
          usernameIsSet: false,
          // Seed presence timestamps so a brand-new user appears in "recently around"
          // immediately, even before they connect a WebSocket.
          lastSeenAt: now,
          lastOnlineAt: now,
          ...(recruitedById ? { recruitedById } : {}),
          ...(signupAttribution ?? {}),
        },
      });
    } catch (err) {
      if (isUniqueViolation(err)) {
        // Lost a race to create this phone number — fetch and treat as login.
        const racedUser = await this.prisma.user.findUnique({ where: { phone } });
        if (racedUser) return racedUser;
      }
      this.logger.error(
        `Failed to create user for phone=${this.maskPhone(phone)}: ${(err as Error)?.message}`,
        (err as Error)?.stack,
      );
      throw new InternalServerErrorException('Could not finish signing you in. Please try again.');
    }
  }

  async meFromSessionToken(token: string | undefined) : Promise<SessionResult | null> {
    return this.sessions.meFromSessionToken(token);
  }

  async revokeSessionToken(token: string | undefined): Promise<void> {
    return this.sessions.revokeSessionToken(token);
  }

  async runMeChecks(token: string, userId: string, pinnedPostId: string | null, userObj: ReturnType<typeof toUserDto>) : Promise<ReturnType<typeof toUserDto>> {
    return this.sessions.runMeChecks(token, userId, pinnedPostId, userObj);
  }

  /**
   * Bust the Redis session cache for every active session belonging to this user.
   * Does NOT revoke the sessions — the user stays logged in; auth guards will
   * simply re-read the DB on the next request and re-populate the cache with
   * fresh user data. Call this whenever a mutation changes fields that /auth/me
   * returns (e.g. onboarding completion, profile changes).
   */
  async bustSessionCachesForUser(userId: string): Promise<void> {
    const id = String(userId ?? '').trim();
    if (!id) return;
    try {
      const sessions = await this.prisma.session.findMany({
        where: { userId: id, revokedAt: null },
        select: { tokenHash: true },
      });
      await Promise.allSettled(
        sessions.map((s) => {
          const th = String(s.tokenHash ?? '').trim();
          return th ? this.cacheInvalidation.deleteSessionFull(th) : Promise.resolve();
        }),
      );
    } catch {
      // Best-effort — a cache miss just means the next request re-fetches from DB.
    }
  }

  async revokeAllSessionsForUser(userId: string): Promise<void> {
    const id = String(userId ?? '').trim();
    if (!id) return;
    // Also sweeps impersonation sessions this user started as a site admin. Those rows are
    // owned by the *target*, so matching on `userId` alone would leave them alive — meaning
    // "sign out everywhere" wouldn't cover a device left mid-impersonation.
    const where: Prisma.SessionWhereInput = {
      revokedAt: null,
      OR: [{ userId: id }, { impersonatedByUserId: id }, { operatedByUserId: id }],
    };
    const sessions = await this.prisma.session.findMany({
      where,
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
    await this.prisma.session.updateMany({
      where,
      data: { revokedAt: new Date() },
    });
  }

  async logout(token: string | undefined, res: Response) {
    await this.revokeSessionToken(token);

    this.clearAuthCookie(res);
    return { success: true };
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

  clearAuthCookie(res: Response) {
    const isProd = this.appConfig.isProd();
    const domain = isProd ? this.appConfig.cookieDomain() ?? '.menofhunger.com' : undefined;
    res.clearCookie(AUTH_COOKIE_NAME, { path: '/', domain });
  }

  async createSessionForUser(
    userId: string,
    res: Response,
    opts?: {
      /** Site admin id when this session is being minted for admin impersonation. */
      impersonatedByUserId?: string | null;
      /** Person driving a page session via the account switcher. */
      operatedByUserId?: string | null;
    },
  ) {
    const token = randomSessionToken();
    const tokenHash = hmacSha256Hex(this.appConfig.sessionHmacSecret(), token);

    const impersonatedByUserId = opts?.impersonatedByUserId ?? null;
    const operatedByUserId = opts?.operatedByUserId ?? null;
    const now = new Date();
    // Impersonation sessions expire in an hour and are never renewed (see `_resolveSession`),
    // so an admin who forgets to exit loses access on their own rather than holding a
    // month-long key to someone else's account.
    const expiresAt = new Date(
      now.getTime() +
        (impersonatedByUserId
          ? IMPERSONATION_SESSION_TTL_MINUTES * 60_000
          : SESSION_TTL_DAYS * 24 * 60 * 60_000),
    );

    const session = await this.prisma.session.create({
      data: {
        userId,
        tokenHash,
        expiresAt,
        impersonatedByUserId,
        operatedByUserId,
      },
    });

    this.setSessionCookie(token, expiresAt, res);
    return session;
  }
}
export type { SessionResult } from './auth-session.types';
