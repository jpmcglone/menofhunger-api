import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { AppConfigService } from '../app/app-config.service';
import { EntitlementService, isPayingSubscriber } from './entitlement.service';
import { FollowsService } from '../follows/follows.service';
import { AffiliateService } from './affiliate.service';
import { toUserListDto } from '../../common/dto/user.dto';
import { USER_LIST_SELECT } from '../../common/prisma-selects/user.select';
import type { ReferralMeDto, RecruitDto } from '../../common/dto/referral.dto';
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
  async setRecruiter(userId: string, code: string): Promise<{ recruiter: { username: string | null; name: string | null } }> {
    const normalized = code.trim().toUpperCase();

    const user = await this.prisma.user.findUnique({
      where: { id: userId },
      select: { recruitedById: true },
    });
    if (!user) throw new NotFoundException('User not found.');
    if (user.recruitedById) {
      throw new BadRequestException('Your recruiter has already been set and cannot be changed.');
    }

    const recruiter = await this.prisma.user.findFirst({
      where: { referralCode: normalized },
      select: { id: true, username: true, name: true, premium: true, verifiedStatus: true },
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

    return { recruiter: { username: recruiter.username ?? null, name: recruiter.name ?? null } };
  }

  // ─── Bonus grant ────────────────────────────────────────────────────────────

  /**
   * Award the one-time referral bonus after the recruit's first Premium payment.
   *
   * Rules:
   *   - The **inviter (recruiter) always** receives +1 month of Premium.
   *   - The **recruit also** receives +1 month, but **only** when the recruiter has an
   *     active paid subscription (Stripe or Apple IAP) at the time the bonus fires.
   *     A recruiter whose premium comes only from a comp/grant does not trigger the
   *     recruit's bonus — the offer is "go Premium yourself and he gets one too."
   *
   * Idempotent: uses an atomic DB update on `referralBonusGrantedAt` so concurrent
   * calls race-free.  Dispatches `referral.bonus.granted` so the side-effects worker
   * can call syncGrantTrialToSubscription for both parties (fixing the Stripe trial
   * window without a DI cycle into BillingService from here).
   */
  async maybeGrantReferralBonus(recruitId: string): Promise<void> {
    const recruit = await this.prisma.user.findUnique({
      where: { id: recruitId },
      select: {
        id: true,
        referralBonusGrantedAt: true,
        recruitedById: true,
        recruitedBy: {
          select: {
            id: true,
            verifiedStatus: true,
            stripeSubscriptionStatus: true,
            appleStatus: true,
            appleExpiresAt: true,
          },
        },
      },
    });

    if (!recruit) return;
    if (recruit.referralBonusGrantedAt) return;
    if (!recruit.recruitedById || !recruit.recruitedBy) return;

    const now = new Date();

    // Atomically claim the bonus slot to prevent double-grants under concurrency.
    const { count } = await this.prisma.user.updateMany({
      where: { id: recruitId, referralBonusGrantedAt: null },
      data: { referralBonusGrantedAt: now },
    });
    if (count === 0) return;

    const recruiterId = recruit.recruitedById;
    const recruiterIsPaying = isPayingSubscriber(recruit.recruitedBy, now);

    // Recruiter always earns a month.
    await this.issueReferralGrant(recruiterId, now);
    // Recruit earns a month only when the recruiter has a paid subscription.
    if (recruiterIsPaying) {
      await this.issueReferralGrant(recruitId, now);
    }

    await this.entitlement.recomputeAndApply(recruiterId);
    await this.entitlement.recomputeAndApply(recruitId);

    this.logger.log(
      `[referral] Bonus granted: recruit=${recruitId} recruiter=${recruiterId} recruiterIsPaying=${recruiterIsPaying}`,
    );

    // Side effect: sync Stripe trial windows for both parties so the free month
    // actually defers billing.  Dispatched (not awaited) to avoid the DI cycle that
    // would arise from injecting BillingService here — BillingService already injects
    // ReferralService.
    this.sideEffects.dispatch('referral.bonus.granted', { recruitId, recruiterId });

    // Record affiliate cash earning for the premium milestone (best-effort; idempotent).
    try {
      await this.affiliate.maybeRecordEarning(recruitId, 'premium');
    } catch (err) {
      this.logger.warn(`[affiliate] Failed to record premium earning for recruit=${recruitId}: ${err}`);
    }
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
        recruitedBy: { select: { id: true, username: true, name: true } },
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
