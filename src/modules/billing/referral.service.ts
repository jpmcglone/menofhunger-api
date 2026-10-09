import { NOT_BANNED_USER_WHERE } from '../../common/prisma-selects/user.where';
import { isUniqueViolation } from '../../common/prisma/errors';
import { BadRequestException, ForbiddenException, Injectable, Logger, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { AppConfigService } from '../app/app-config.service';
import { EntitlementService, isPayingSubscriber } from './entitlement.service';
import { FollowsService } from '../follows/follows.service';
import { AffiliateService } from './affiliate.service';
import { toUserListDto } from '../../common/dto/user.dto';
import { USER_BRIEF_SELECT, USER_LIST_SELECT } from '../../common/prisma-selects/user.select';
import type { ReferralMeDto, RecruitDto } from '../../common/dto/referral.dto';
import { publicAssetUrl } from '../../common/assets/public-asset-url';
import { SideEffectsService } from '../side-effects/side-effects.service';

// Validated after uppercasing, so lowercase input is accepted and normalized.
const REFERRAL_CODE_REGEX = /^[A-Z0-9_-]{3,20}$/;
const REFERRAL_BONUS_MONTHS = 1;

/** Adds REFERRAL_BONUS_MONTHS to a Date, stacking from the furthest-out existing active grant end. */
function addMonths(date: Date, months: number): Date {
  const d = new Date(date);
  d.setUTCMonth(d.getUTCMonth() + months);
  return d;
}

@Injectable()
export class ReferralService {
  private readonly logger = new Logger(ReferralService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly appConfig: AppConfigService,
    private readonly entitlement: EntitlementService,
    private readonly follows: FollowsService,
    private readonly affiliate: AffiliateService,
    // Dispatching auto-verify instead of calling it also removes what used to be a
    // load-time cycle here: ReferralService → UserVerificationService → BillingService →
    // ReferralService.
    private readonly sideEffects: SideEffectsService,
  ) {}

  // ─── Referral code management ───────────────────────────────────────────────

  /** Get the calling user's referral info (code, recruiter, recruit count, bonus status). */
  async getMyReferralInfo(userId: string): Promise<ReferralMeDto> {
    const user = await this.prisma.user.findUnique({
      where: { id: userId },
      select: {
        referralCode: true,
        referralBonusGrantedAt: true,
        verifiedStatus: true,
        premium: true,
        stripeSubscriptionStatus: true,
        appleStatus: true,
        appleExpiresAt: true,
        recruitedBy: { select: { username: true, name: true } },
        _count: { select: { recruits: true } },
      },
    });
    if (!user) throw new NotFoundException('User not found.');

    const referralGrants = await this.prisma.subscriptionGrant.aggregate({
      where: { userId, source: 'referral' },
      _sum: { months: true },
    });

    const canInvite = user.verifiedStatus !== 'none' || Boolean(user.premium);
    const isPayingPremium = isPayingSubscriber({
      verifiedStatus: user.verifiedStatus,
      stripeSubscriptionStatus: user.stripeSubscriptionStatus,
      appleStatus: user.appleStatus,
      appleExpiresAt: user.appleExpiresAt,
    });

    return {
      referralCode: user.referralCode ?? null,
      recruiter: user.recruitedBy
        ? { username: user.recruitedBy.username ?? null, name: user.recruitedBy.name ?? null }
        : null,
      recruitCount: user._count.recruits,
      referralBonusGranted: user.referralBonusGrantedAt !== null,
      canInvite,
      isPayingPremium,
      monthsEarned: referralGrants._sum.months ?? 0,
    };
  }

  /**
   * Set or update the calling user's referral code.
   * Codes are normalized to uppercase before storage so the DB unique constraint works correctly.
   * Verified members (identity or manual) and premium members may hold a referral code.
   */
  async setReferralCode(userId: string, code: string): Promise<{ referralCode: string }> {
    const normalized = code.trim().toUpperCase();
    if (!REFERRAL_CODE_REGEX.test(normalized)) {
      throw new BadRequestException(
        'Referral code must be 3–20 characters and contain only letters, numbers, hyphens, and underscores.',
      );
    }

    const user = await this.prisma.user.findUnique({
      where: { id: userId },
      select: { premium: true, verifiedStatus: true, referralCode: true },
    });
    if (!user) throw new NotFoundException('User not found.');
    if (!user.premium && user.verifiedStatus === 'none') {
      throw new ForbiddenException('Only verified members can set a referral code.');
    }

    // Check uniqueness (exclude self). Exact match is sufficient since codes are always uppercased.
    const conflict = await this.prisma.user.findFirst({
      where: { referralCode: normalized, NOT: { id: userId } },
      select: { id: true },
    });
    if (conflict) throw new BadRequestException('That referral code is already taken. Please choose another.');

    await this.prisma.user.update({
      where: { id: userId },
      data: { referralCode: normalized },
    });

    return { referralCode: normalized };
  }

  /** List the users recruited by the calling user. */
  async getMyRecruits(userId: string): Promise<RecruitDto[]> {
    const recruits = await this.prisma.user.findMany({
      where: { recruitedById: userId },
      select: {
        ...USER_LIST_SELECT,
        createdAt: true,
        referralBonusGrantedAt: true,
      },
      orderBy: { createdAt: 'desc' },
    });

    const publicBaseUrl = this.appConfig.r2()?.publicBaseUrl ?? null;
    return recruits.map((r) => {
      const base = toUserListDto(r, publicBaseUrl);
      return {
        ...base,
        recruitedAt: r.createdAt.toISOString(),
        isVerified: r.verifiedStatus !== 'none',
        isPremium: r.premium,
        bonusGranted: r.referralBonusGrantedAt !== null,
      };
    });
  }

  // ─── Set recruiter ──────────────────────────────────────────────────────────

  /**
   * Apply a referral code to link this user to a recruiter.
   * Once set, the recruiter can never be changed by the user.
   * The code owner must be verified (or premium) at the time of linking.
   */
  /** Public, cookie-free lookup so the invite landing page can show who invited the visitor. */
  async lookupPublicInviter(
    code: string,
  ): Promise<{ username: string | null; name: string | null; avatarUrl: string | null }> {
    const normalized = code.trim().toUpperCase();
    if (!REFERRAL_CODE_REGEX.test(normalized)) throw new NotFoundException('Invite not found.');
    const inviter = await this.prisma.user.findFirst({
      where: { referralCode: normalized, ...NOT_BANNED_USER_WHERE },
      select: {
        username: true,
        name: true,
        premium: true,
        verifiedStatus: true,
        avatarKey: true,
        avatarUpdatedAt: true,
      },
    });
    if (!inviter || (!inviter.premium && inviter.verifiedStatus === 'none')) {
      throw new NotFoundException('Invite not found.');
    }
    return {
      username: inviter.username ?? null,
      name: inviter.name ?? null,
      avatarUrl: publicAssetUrl({
        publicBaseUrl: this.appConfig.r2()?.publicBaseUrl ?? null,
        key: inviter.avatarKey ?? null,
        updatedAt: inviter.avatarUpdatedAt ?? null,
      }),
    };
  }

  async setRecruiter(userId: string, code: string): Promise<{ recruiter: { username: string | null; name: string | null } }> {
    const normalized = code.trim().toUpperCase();

    const user = await this.prisma.user.findUnique({
      where: { id: userId },
      select: { recruitedById: true, verifiedStatus: true },
    });
    if (!user) throw new NotFoundException('User not found.');
    if (user.recruitedById) {
      throw new BadRequestException('Your recruiter has already been set and cannot be changed.');
    }

    const recruiter = await this.prisma.user.findFirst({
      where: { referralCode: normalized },
      select: { ...USER_BRIEF_SELECT, premium: true, verifiedStatus: true },
    });
    if (!recruiter) throw new BadRequestException('Invalid referral code.');
    if (!recruiter.premium && recruiter.verifiedStatus === 'none') {
      throw new BadRequestException('That referral code is no longer active.');
    }
    if (recruiter.id === userId) {
      throw new BadRequestException('You cannot use your own referral code.');
    }

    await this.prisma.user.update({
      where: { id: userId },
      data: { recruitedById: recruiter.id },
    });

    this.logger.log(`[referral] User ${userId} linked recruiter ${recruiter.id} via code "${normalized}"`);

    // Automatically follow the recruiter — a natural win for both sides.
    if (recruiter.username) {
      try {
        await this.follows.follow({ viewerUserId: userId, username: recruiter.username });
      } catch (err) {
        this.logger.warn(`[referral] Auto-follow failed for user ${userId} → ${recruiter.id}: ${err}`);
      }
    }

    // The handler re-reads the site toggle and does the verification (coins, affiliate
    // earnings, Stripe billing hooks) off the request path.
    this.sideEffects.dispatch('user.auto-verify', {
      userId,
      recruitedById: recruiter.id,
      source: 'auto_referral',
    });

    // A member who verified before linking a recruiter would otherwise never trigger the bonus.
    if (user.verifiedStatus !== 'none') {
      this.sideEffects.dispatch('referral.verified', { userId });
    }

    return { recruiter: { username: recruiter.username ?? null, name: recruiter.name ?? null } };
  }

  // ─── Bonus grant ────────────────────────────────────────────────────────────

  /**
   * Award the one-time, two-sided referral bonus when a recruited member becomes verified.
   *
   * Both the recruiter and the recruit receive +1 month of Premium, with no paid plan
   * required. Verification is the abuse gate, so an unverified recruit or a banned
   * recruiter never triggers it.
   *
   * Idempotent: an atomic DB update on `referralBonusGrantedAt` makes concurrent calls
   * race-free. Dispatches `referral.bonus.granted` so the side-effects worker can sync
   * Stripe trial windows and notify both parties (without a DI cycle into BillingService).
   */
  async maybeGrantReferralBonus(recruitId: string): Promise<void> {
    const recruit = await this.prisma.user.findUnique({
      where: { id: recruitId },
      select: {
        id: true,
        verifiedStatus: true,
        referralBonusGrantedAt: true,
        recruitedById: true,
        recruitedBy: { select: { id: true, bannedAt: true } },
      },
    });

    if (!recruit) return;
    if (recruit.referralBonusGrantedAt) return;
    if (recruit.verifiedStatus === 'none') return;
    if (!recruit.recruitedById || !recruit.recruitedBy || recruit.recruitedBy.bannedAt) return;

    const now = new Date();

    // Atomically claim the bonus slot to prevent double-grants under concurrency.
    const { count } = await this.prisma.user.updateMany({
      where: { id: recruitId, referralBonusGrantedAt: null },
      data: { referralBonusGrantedAt: now },
    });
    if (count === 0) return;

    const recruiterId = recruit.recruitedById;

    await this.issueReferralGrant(recruiterId, now);
    await this.issueReferralGrant(recruitId, now);

    await this.entitlement.recomputeAndApply(recruiterId);
    await this.entitlement.recomputeAndApply(recruitId);

    this.logger.log(`[referral] Bonus granted: recruit=${recruitId} recruiter=${recruiterId}`);

    this.sideEffects.dispatch('referral.bonus.granted', { recruitId, recruiterId });
  }

  /** Affiliate cash milestone for a recruit's first paid Premium (idempotent, best-effort). */
  async recordPremiumMilestone(recruitId: string): Promise<void> {
    try {
      await this.affiliate.maybeRecordEarning(recruitId, 'premium');
    } catch (err) {
      this.logger.warn(`[affiliate] Failed to record premium earning for recruit=${recruitId}: ${err}`);
    }
  }

  /**
   * Give a verified member a referral link without them having to pick a code.
   * Derived from the username (already `[A-Za-z0-9_]`), with a numeric suffix on collision.
   * Never replaces an existing code.
   */
  async ensureCode(userId: string): Promise<string | null> {
    const user = await this.prisma.user.findUnique({
      where: { id: userId },
      select: { username: true, referralCode: true, verifiedStatus: true, premium: true },
    });
    if (!user) return null;
    if (user.referralCode) return user.referralCode;
    if (user.verifiedStatus === 'none' && !user.premium) return null;
    const base = (user.username ?? '').toUpperCase().replace(/[^A-Z0-9_-]/g, '');
    if (base.length < 3) return null;

    for (let attempt = 0; attempt < 10; attempt++) {
      const suffix = attempt === 0 ? '' : String(attempt + 1);
      const candidate = `${base.slice(0, 20 - suffix.length)}${suffix}`;
      try {
        // Guarded write: only fills the code when it is still empty.
        const { count } = await this.prisma.user.updateMany({
          where: { id: userId, referralCode: null },
          data: { referralCode: candidate },
        });
        if (count === 0) {
          const current = await this.prisma.user.findUnique({ where: { id: userId }, select: { referralCode: true } });
          return current?.referralCode ?? null;
        }
        return candidate;
      } catch (err) {
        if (isUniqueViolation(err)) continue;
        throw err;
      }
    }
    return null;
  }

  /** Runs everything a newly verified member is owed from the referral program. */
  async onMemberVerified(userId: string): Promise<void> {
    await this.ensureCode(userId);
    await this.maybeGrantReferralBonus(userId);
  }

  private async issueReferralGrant(userId: string, now: Date): Promise<void> {
    // Stack from the furthest-out existing active grant for this user.
    const latestGrant = await this.prisma.subscriptionGrant.findFirst({
      where: { userId, revokedAt: null, endsAt: { gt: now } },
      orderBy: { endsAt: 'desc' },
    });
    const startsAt = latestGrant ? latestGrant.endsAt : now;
    const endsAt = addMonths(startsAt, REFERRAL_BONUS_MONTHS);

    await this.prisma.subscriptionGrant.create({
      data: {
        userId,
        tier: 'premium',
        source: 'referral',
        months: REFERRAL_BONUS_MONTHS,
        startsAt,
        endsAt,
        // requiresActiveSubscription: false so the month is real standalone access —
        // a non-paying verified inviter still gets a month of Premium they can use immediately.
        requiresActiveSubscription: false,
        reason: 'Referral bonus',
      },
    });
  }

  // ─── Admin helpers ──────────────────────────────────────────────────────────

  /** Get referral info for a specific user (admin use). */
  async getAdminReferralInfo(userId: string) {
    const user = await this.prisma.user.findUnique({
      where: { id: userId },
      select: {
        referralCode: true,
        referralBonusGrantedAt: true,
        recruitedBy: { select: USER_BRIEF_SELECT },
        recruits: {
          select: {
            ...USER_LIST_SELECT,
            createdAt: true,
            referralBonusGrantedAt: true,
          },
          orderBy: { createdAt: 'desc' },
        },
      },
    });
    if (!user) throw new NotFoundException('User not found.');

    const publicBaseUrl = this.appConfig.r2()?.publicBaseUrl ?? null;

    return {
      referralCode: user.referralCode ?? null,
      bonusGrantedAt: user.referralBonusGrantedAt?.toISOString() ?? null,
      recruiter: user.recruitedBy
        ? {
            id: user.recruitedBy.id,
            username: user.recruitedBy.username ?? null,
            name: user.recruitedBy.name ?? null,
          }
        : null,
      recruits: user.recruits.map((r) => {
        const base = toUserListDto(r, publicBaseUrl);
        return {
          ...base,
          recruitedAt: r.createdAt.toISOString(),
          isVerified: r.verifiedStatus !== 'none',
          isPremium: r.premium,
          bonusGranted: r.referralBonusGrantedAt !== null,
        };
      }),
    };
  }
}
