import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { EntitlementService } from './entitlement.service';
import { FollowsService } from '../follows/follows.service';
import type { ReferralMeDto, RecruitDto } from '../../common/dto/referral.dto';

// Validated after uppercasing, so lowercase input is accepted and normalized.
const REFERRAL_CODE_REGEX = /^[A-Z0-9_-]{4,20}$/;
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
    private readonly entitlement: EntitlementService,
    private readonly follows: FollowsService,
  ) {}

  // ─── Referral code management ───────────────────────────────────────────────

  /** Get the calling user's referral info (code, recruiter, recruit count, bonus status). */
  async getMyReferralInfo(userId: string): Promise<ReferralMeDto> {
    const user = await this.prisma.user.findUnique({
      where: { id: userId },
      select: {
        referralCode: true,
        referralBonusGrantedAt: true,
        recruitedBy: { select: { username: true, name: true } },
        _count: { select: { recruits: true } },
      },
    });
    if (!user) throw new NotFoundException('User not found.');

    return {
      referralCode: user.referralCode ?? null,
      recruiter: user.recruitedBy
        ? { username: user.recruitedBy.username ?? null, name: user.recruitedBy.name ?? null }
        : null,
      recruitCount: user._count.recruits,
      referralBonusGranted: user.referralBonusGrantedAt !== null,
    };
  }

  /**
   * Set or update the calling user's referral code.
   * Codes are normalized to uppercase before storage so the DB unique constraint works correctly.
   * Only premium users may hold a referral code.
   */
  async setReferralCode(userId: string, code: string): Promise<{ referralCode: string }> {
    const normalized = code.trim().toUpperCase();
    if (!REFERRAL_CODE_REGEX.test(normalized)) {
      throw new BadRequestException(
        'Referral code must be 4–20 characters and contain only letters, numbers, hyphens, and underscores.',
      );
    }

    const user = await this.prisma.user.findUnique({
      where: { id: userId },
      select: { premium: true, referralCode: true },
    });
    if (!user) throw new NotFoundException('User not found.');
    if (!user.premium) {
      throw new ForbiddenException('Only premium members can set a referral code.');
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
        id: true,
        username: true,
        name: true,
        avatarKey: true,
        createdAt: true,
        premium: true,
        referralBonusGrantedAt: true,
      },
      orderBy: { createdAt: 'desc' },
    });

    return recruits.map((r) => ({
      id: r.id,
      username: r.username ?? null,
      name: r.name ?? null,
      avatarKey: r.avatarKey ?? null,
      recruitedAt: r.createdAt.toISOString(),
      isPremium: r.premium,
      bonusGranted: r.referralBonusGrantedAt !== null,
    }));
  }

  // ─── Set recruiter ──────────────────────────────────────────────────────────

  /**
   * Apply a referral code to link this user to a recruiter.
   * Once set, the recruiter can never be changed by the user.
   * The code owner must be premium at the time of linking.
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
      select: { id: true, username: true, name: true, premium: true },
    });
    if (!recruiter) throw new BadRequestException('Invalid referral code.');
    if (!recruiter.premium) {
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

    return { recruiter: { username: recruiter.username ?? null, name: recruiter.name ?? null } };
  }

  // ─── Bonus grant ────────────────────────────────────────────────────────────

  /**
   * Award the one-time referral bonus to both the recruit and their recruiter.
   * Called after the recruit's first Stripe payment goes through.
   * Idempotent: uses an atomic DB update to mark the bonus as granted before issuing grants,
   * preventing duplicate grants if called concurrently.
   */
  async maybeGrantReferralBonus(recruitId: string): Promise<void> {
    const recruit = await this.prisma.user.findUnique({
      where: { id: recruitId },
      select: {
        id: true,
        referralBonusGrantedAt: true,
        recruitedById: true,
        recruitedBy: { select: { id: true } },
      },
    });

    if (!recruit) return;
    if (recruit.referralBonusGrantedAt) return; // fast-path: already done
    if (!recruit.recruitedById || !recruit.recruitedBy) return; // no recruiter

    const now = new Date();

    // Atomically claim the bonus slot. If another process already claimed it,
    // updateMany returns count=0 and we bail out — preventing double grants.
    const { count } = await this.prisma.user.updateMany({
      where: { id: recruitId, referralBonusGrantedAt: null },
      data: { referralBonusGrantedAt: now },
    });
    if (count === 0) return;

    const recruiterId = recruit.recruitedById;

    await this.issueReferralGrant(recruitId, now);
    await this.issueReferralGrant(recruiterId, now);

    await this.entitlement.recomputeAndApply(recruitId);
    await this.entitlement.recomputeAndApply(recruiterId);

    this.logger.log(`[referral] Bonus granted: recruit=${recruitId} recruiter=${recruiterId}`);
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
        requiresActiveSubscription: true,
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
            id: true,
            username: true,
            name: true,
            avatarKey: true,
            createdAt: true,
            premium: true,
            referralBonusGrantedAt: true,
          },
          orderBy: { createdAt: 'desc' },
        },
      },
    });
    if (!user) throw new NotFoundException('User not found.');

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
      recruits: user.recruits.map((r) => ({
        id: r.id,
        username: r.username ?? null,
        name: r.name ?? null,
        avatarKey: r.avatarKey ?? null,
        recruitedAt: r.createdAt.toISOString(),
        isPremium: r.premium,
        bonusGranted: r.referralBonusGrantedAt !== null,
      })),
    };
  }
}
