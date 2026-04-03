import { Controller, Get, Param, UseGuards } from '@nestjs/common';
import { AdminGuard } from './admin.guard';
import { ReferralService } from '../billing/referral.service';
import { PrismaService } from '../prisma/prisma.service';
import type { AdminReferralInfoDto, AdminReferralAnalyticsDto } from '../../common/dto';

@UseGuards(AdminGuard)
@Controller('admin')
export class AdminReferralController {
  constructor(
    private readonly referral: ReferralService,
    private readonly prisma: PrismaService,
  ) {}

  /** Get referral info for a specific user. */
  @Get('users/:id/referral')
  async getUserReferral(@Param('id') id: string): Promise<{ data: AdminReferralInfoDto }> {
    return { data: await this.referral.getAdminReferralInfo(id) };
  }

  /** Aggregate referral analytics for the admin dashboard. */
  @Get('analytics/referrals')
  async getReferralAnalytics(): Promise<{ data: AdminReferralAnalyticsDto }> {
    const [
      totalCodesCreated,
      totalRecruits,
      totalBonusesGranted,
      totalPremiumRecruits,
      recruitsOverTimeRaw,
      topRecruitersRaw,
    ] = await Promise.all([
      this.prisma.user.count({ where: { referralCode: { not: null } } }),
      this.prisma.user.count({ where: { recruitedById: { not: null } } }),
      this.prisma.user.count({ where: { referralBonusGrantedAt: { not: null } } }),
      this.prisma.user.count({ where: { recruitedById: { not: null }, premium: true } }),
      // Recruits over time — last 30 days by day.
      this.prisma.$queryRaw<Array<{ bucket: Date; count: bigint }>>`
        SELECT date_trunc('day', "createdAt") AS bucket, COUNT(*) AS count
        FROM "User"
        WHERE "recruitedById" IS NOT NULL
          AND "createdAt" >= NOW() - INTERVAL '30 days'
        GROUP BY bucket
        ORDER BY bucket ASC
      `,
      // Top 10 recruiters by recruit count.
      this.prisma.$queryRaw<Array<{ id: string; username: string | null; name: string | null; recruit_count: bigint }>>`
        SELECT u.id, u.username, u.name, COUNT(r.id) AS recruit_count
        FROM "User" u
        JOIN "User" r ON r."recruitedById" = u.id
        GROUP BY u.id, u.username, u.name
        ORDER BY recruit_count DESC
        LIMIT 10
      `,
    ]);

    const conversionRatePct =
      totalRecruits > 0 ? Math.round((totalPremiumRecruits / totalRecruits) * 100) : 0;

    return {
      data: {
        totalCodesCreated,
        totalRecruits,
        totalBonusesGranted,
        conversionRatePct,
        recruitsOverTime: recruitsOverTimeRaw.map((r) => ({
          bucket: r.bucket.toISOString().split('T')[0]!,
          count: Number(r.count),
        })),
        topRecruiters: topRecruitersRaw.map((r) => ({
          userId: r.id,
          username: r.username ?? null,
          name: r.name ?? null,
          recruitCount: Number(r.recruit_count),
        })),
      },
    };
  }
}
