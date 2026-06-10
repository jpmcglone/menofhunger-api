import { BadRequestException, Injectable, Logger, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { AppConfigService } from '../app/app-config.service';
import { PresenceRealtimeService } from '../presence/presence-realtime.service';
import { toUserListDto } from '../../common/dto/user.dto';
import { USER_LIST_SELECT } from '../../common/prisma-selects/user.select';
import type {
  AffiliateSummaryDto,
  AffiliateEarningDto,
  AdminAffiliateUserDto,
  AdminAffiliateSettleDto,
} from '../../common/dto/affiliate.dto';
import type { RecruitDto } from '../../common/dto/referral.dto';

/** Cash rates in cents per recruit milestone. */
export const AFFILIATE_RATES_CENTS = {
  signup: 100,
  verified: 300,
  premium: 1000,
  premium60d: 1000,
} as const;

/** Minimum pending balance required for admin to settle a payout. */
export const AFFILIATE_MIN_PAYOUT_CENTS = 5_000; // $50

/** Per-member lifetime earnings cap. Stops new accrual once reached. */
export const AFFILIATE_CAP_CENTS = 100_000; // $1,000

/** Days after first premium payment before the retention milestone fires. */
export const AFFILIATE_PREMIUM_RETENTION_DAYS = 60;

type EarningType = keyof typeof AFFILIATE_RATES_CENTS;

@Injectable()
export class AffiliateService {
  private readonly logger = new Logger(AffiliateService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly appConfig: AppConfigService,
    private readonly realtime: PresenceRealtimeService,
  ) {}

  // ─── Earning creation ───────────────────────────────────────────────────────

  /**
   * Record a cash earning for an affiliate when one of their recruits reaches a milestone.
   * No-ops if:
   *   - The recruit has no recruiter.
   *   - The recruiter is not an affiliate at the time of the event.
   *   - The recruit signed up BEFORE the recruiter's affiliateAt date (outside pilot window).
   *   - The per-member cap has already been reached.
   *   - The earning already exists (idempotency via unique constraint).
   */
  async maybeRecordEarning(recruitId: string, type: EarningType): Promise<{ affiliateUserId: string | null }> {
    const recruit = await this.prisma.user.findUnique({
      where: { id: recruitId },
      select: {
        createdAt: true,
        recruitedById: true,
        recruitedBy: { select: { id: true, affiliateAt: true } },
      },
    });

    if (!recruit?.recruitedById || !recruit.recruitedBy?.affiliateAt) {
      return { affiliateUserId: null };
    }

    // Qualification: recruit must have joined after the recruiter became a pilot member.
    if (recruit.createdAt < recruit.recruitedBy.affiliateAt) {
      this.logger.debug(
        `[affiliate] Skipping ${type} for recruit=${recruitId}: joined before affiliateAt`,
      );
      return { affiliateUserId: null };
    }

    const affiliateUserId = recruit.recruitedBy.id;
    const amountCents = AFFILIATE_RATES_CENTS[type];

    // Cap check: skip if adding this earning would exceed the per-member cap.
    const totalEarned = await this.prisma.affiliateEarning.aggregate({
      where: { affiliateUserId },
      _sum: { amountCents: true },
    });
    const currentTotal = totalEarned._sum.amountCents ?? 0;
    if (currentTotal + amountCents > AFFILIATE_CAP_CENTS) {
      this.logger.log(
        `[affiliate] Cap reached for affiliate=${affiliateUserId}: current=${currentTotal}¢ + ${amountCents}¢ > cap=${AFFILIATE_CAP_CENTS}¢`,
      );
      return { affiliateUserId: null };
    }

    try {
      await this.prisma.affiliateEarning.create({
        data: {
          affiliateUserId,
          recruitUserId: recruitId,
          type,
          amountCents,
        },
      });
      this.logger.log(`[affiliate] Earning recorded: affiliate=${affiliateUserId} recruit=${recruitId} type=${type} cents=${amountCents}`);

      // Emit realtime update to the recruiter so their /referrals dashboard updates live.
      try {
        const recruitUser = await this.prisma.user.findUnique({
          where: { id: recruitId },
          select: {
            ...USER_LIST_SELECT,
            createdAt: true,
            referralBonusGrantedAt: true,
          },
        });
        if (recruitUser) {
          const publicBaseUrl = this.appConfig.r2()?.publicBaseUrl ?? null;
          const base = toUserListDto(recruitUser, publicBaseUrl);
          const recruitDto: RecruitDto = {
            ...base,
            recruitedAt: recruitUser.createdAt.toISOString(),
            isVerified: recruitUser.verifiedStatus !== 'none',
            isPremium: recruitUser.premium,
            bonusGranted: recruitUser.referralBonusGrantedAt !== null,
          };
          this.realtime.emitReferralRecruitUpdated(affiliateUserId, { recruit: recruitDto });
        }
      } catch (emitErr) {
        this.logger.warn(`[affiliate] Realtime emit failed for affiliate=${affiliateUserId}: ${emitErr}`);
      }
    } catch (err: unknown) {
      // P2002 = unique constraint violation → already recorded, ignore.
      if ((err as any)?.code === 'P2002') {
        this.logger.debug(`[affiliate] Earning already recorded: recruit=${recruitId} type=${type}`);
      } else {
        throw err;
      }
    }

    return { affiliateUserId };
  }

  // ─── User-facing summary ────────────────────────────────────────────────────

  /** Return the affiliate summary for the calling user. Non-affiliates get { isAffiliate: false }. */
  async getAffiliateSummary(userId: string): Promise<AffiliateSummaryDto> {
    const user = await this.prisma.user.findUnique({
      where: { id: userId },
      select: { affiliateAt: true },
    });
    if (!user) throw new NotFoundException('User not found.');
    if (!user.affiliateAt) return { isAffiliate: false };

    const earnings = await this.prisma.affiliateEarning.findMany({
      where: { affiliateUserId: userId },
      include: { recruit: { select: { username: true, name: true } } },
      orderBy: { createdAt: 'desc' },
    });

    const pendingCents = earnings.filter((e) => !e.settledAt).reduce((sum, e) => sum + e.amountCents, 0);
    const settledCents = earnings.filter((e) => e.settledAt).reduce((sum, e) => sum + e.amountCents, 0);
    const totalCents = pendingCents + settledCents;

    return {
      isAffiliate: true,
      pendingCents,
      settledCents,
      totalCents,
      minPayoutCents: AFFILIATE_MIN_PAYOUT_CENTS,
      capCents: AFFILIATE_CAP_CENTS,
      capReached: totalCents >= AFFILIATE_CAP_CENTS,
      counts: {
        signups: earnings.filter((e) => e.type === 'signup').length,
        verified: earnings.filter((e) => e.type === 'verified').length,
        premium: earnings.filter((e) => e.type === 'premium').length,
        premium60d: earnings.filter((e) => e.type === 'premium60d').length,
      },
      earnings: earnings.map((e) => toAffiliateEarningDto(e)),
    };
  }

  // ─── Admin ──────────────────────────────────────────────────────────────────

  /** List all affiliates with their pending/settled totals (for admin). */
  async listAffiliates(): Promise<AdminAffiliateUserDto[]> {
    const affiliates = await this.prisma.user.findMany({
      where: { affiliateAt: { not: null } },
      select: {
        id: true,
        username: true,
        name: true,
        affiliateAt: true,
        _count: { select: { recruits: true } },
        affiliateEarningsAsAffiliate: {
          select: { amountCents: true, settledAt: true },
        },
      },
      orderBy: { affiliateAt: 'desc' },
    });

    return affiliates.map((u) => {
      const earnings = u.affiliateEarningsAsAffiliate;
      const pendingCents = earnings.filter((e) => !e.settledAt).reduce((s, e) => s + e.amountCents, 0);
      const settledCents = earnings.filter((e) => e.settledAt).reduce((s, e) => s + e.amountCents, 0);
      const totalCents = pendingCents + settledCents;
      return {
        userId: u.id,
        username: u.username ?? null,
        name: u.name ?? null,
        affiliateAt: u.affiliateAt!.toISOString(),
        recruitCount: u._count.recruits,
        pendingCents,
        settledCents,
        totalCents,
        capCents: AFFILIATE_CAP_CENTS,
        capReached: totalCents >= AFFILIATE_CAP_CENTS,
      };
    });
  }

  /** Enable or disable affiliate status for a user. */
  async setAffiliateStatus(userId: string, enable: boolean): Promise<void> {
    const user = await this.prisma.user.findUnique({ where: { id: userId }, select: { id: true } });
    if (!user) throw new NotFoundException('User not found.');

    await this.prisma.user.update({
      where: { id: userId },
      data: { affiliateAt: enable ? new Date() : null },
    });

    this.logger.log(`[affiliate] User ${userId} affiliate=${enable}`);
  }

  /** Mark all pending earnings for an affiliate as settled. Returns what was settled. */
  async settleAffiliate(affiliateUserId: string): Promise<AdminAffiliateSettleDto> {
    const user = await this.prisma.user.findUnique({
      where: { id: affiliateUserId },
      select: { id: true, affiliateAt: true },
    });
    if (!user) throw new NotFoundException('User not found.');

    const pending = await this.prisma.affiliateEarning.findMany({
      where: { affiliateUserId, settledAt: null },
      select: { id: true, amountCents: true },
    });

    const pendingTotal = pending.reduce((s, e) => s + e.amountCents, 0);

    if (pendingTotal < AFFILIATE_MIN_PAYOUT_CENTS) {
      throw new BadRequestException(
        `Minimum payout is $${AFFILIATE_MIN_PAYOUT_CENTS / 100}. Pending balance is $${(pendingTotal / 100).toFixed(2)}.`,
      );
    }

    const now = new Date();
    await this.prisma.affiliateEarning.updateMany({
      where: { affiliateUserId, settledAt: null },
      data: { settledAt: now },
    });

    this.logger.log(`[affiliate] Settled ${pending.length} earnings for affiliate=${affiliateUserId} total=${pendingTotal}¢`);

    return { settledCount: pending.length, settledCents: pendingTotal };
  }
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

function toAffiliateEarningDto(
  e: {
    id: string;
    recruitUserId: string;
    recruit: { username: string | null; name: string | null };
    type: string;
    amountCents: number;
    createdAt: Date;
    settledAt: Date | null;
  },
): AffiliateEarningDto {
  return {
    id: e.id,
    recruitUserId: e.recruitUserId,
    recruitUsername: e.recruit.username ?? null,
    recruitName: e.recruit.name ?? null,
    type: e.type as AffiliateEarningDto['type'],
    amountCents: e.amountCents,
    createdAt: e.createdAt.toISOString(),
    settledAt: e.settledAt?.toISOString() ?? null,
  };
}
