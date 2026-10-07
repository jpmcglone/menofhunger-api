import { Controller, Get, Param, Query, UseGuards } from '@nestjs/common';
import { z } from 'zod';
import { AdminGuard } from './admin.guard';
import { AdminReferralService } from './admin-referral.service';
import { ReferralService } from '../billing/referral.service';
import type { AdminAcquisitionDto, AdminNewMemberPostsDto, AdminReferralInfoDto, AdminReferralAnalyticsDto } from '../../common/dto';

const acquisitionQuerySchema = z.object({
  days: z.coerce.number().int().min(1).max(90).default(7),
});

const newMemberPostsQuerySchema = z.object({
  newMembersDays: z.coerce.number().int().min(1).max(30).default(7),
  minAgeMinutes: z.coerce.number().int().min(0).max(7 * 24 * 60).default(60),
  limit: z.coerce.number().int().min(1).max(50).default(25),
});

@UseGuards(AdminGuard)
@Controller('admin')
export class AdminReferralController {
  constructor(
    private readonly referral: ReferralService,
    private readonly referralAnalytics: AdminReferralService,
  ) {}

  /** Get referral info for a specific user. */
  @Get('users/:id/referral')
  async getUserReferral(@Param('id') id: string): Promise<{ data: AdminReferralInfoDto }> {
    return { data: await this.referral.getAdminReferralInfo(id) };
  }

  /** Signups and verified members by signup source and campaign. */
  @Get('analytics/acquisition')
  async getAcquisition(@Query() query: unknown): Promise<{ data: AdminAcquisitionDto }> {
    const { days } = acquisitionQuerySchema.parse(query);
    return { data: await this.referralAnalytics.acquisition(days) };
  }

  /** Top-level posts by recent joiners that have no replies yet. */
  @Get('analytics/new-member-posts')
  async getNewMemberPosts(@Query() query: unknown): Promise<{ data: AdminNewMemberPostsDto }> {
    const q = newMemberPostsQuerySchema.parse(query);
    return {
      data: await this.referralAnalytics.newMemberPosts({
        newMemberDays: q.newMembersDays,
        minAgeMinutes: q.minAgeMinutes,
        limit: q.limit,
      }),
    };
  }

  /** Aggregate referral analytics for the admin dashboard. */
  @Get('analytics/referrals')
  async getReferralAnalytics(): Promise<{ data: AdminReferralAnalyticsDto }> {
    return { data: await this.referralAnalytics.referralAnalytics() };
  }
}
