import { Body, Controller, Get, NotFoundException, Param, Patch, Post, UseGuards } from '@nestjs/common';
import { AdminGuard } from './admin.guard';
import { AffiliateService } from '../billing/affiliate.service';
import { UserLookupService } from '../user-lookup/user-lookup.service';
import type { AdminAffiliateUserDto, AdminAffiliateSettleDto } from '../../common/dto';
import { setAffiliateSchema } from './admin-affiliate.schemas';

@UseGuards(AdminGuard)
@Controller('admin')
export class AdminAffiliateController {
  constructor(
    private readonly affiliate: AffiliateService,
    private readonly userLookup: UserLookupService,
  ) {}

  /** List all affiliates with pending/settled totals. */
  @Get('affiliates')
  async listAffiliates(): Promise<{ data: AdminAffiliateUserDto[] }> {
    return { data: await this.affiliate.listAffiliates() };
  }

  /** Get affiliate status for a specific user. */
  @Get('users/:id/affiliate')
  async getUserAffiliate(
    @Param('id') id: string,
  ): Promise<{ data: { userId: string; isAffiliate: boolean; affiliateAt: string | null } }> {
    const user = await this.userLookup.findById(id, { id: true, affiliateAt: true });
    if (!user) throw new NotFoundException('User not found.');
    return {
      data: {
        userId: user.id,
        isAffiliate: user.affiliateAt !== null,
        affiliateAt: user.affiliateAt?.toISOString() ?? null,
      },
    };
  }

  /** Enable or disable affiliate status for a user. */
  @Patch('users/:id/affiliate')
  async setAffiliate(
    @Param('id') id: string,
    @Body() body: unknown,
  ): Promise<{ data: { userId: string; isAffiliate: boolean } }> {
    const parsed = setAffiliateSchema.parse(body);
    await this.affiliate.setAffiliateStatus(id, parsed.enabled);
    return { data: { userId: id, isAffiliate: parsed.enabled } };
  }

  /** Mark all pending earnings settled for a specific affiliate. */
  @Post('affiliates/:userId/settle')
  async settle(
    @Param('userId') userId: string,
  ): Promise<{ data: AdminAffiliateSettleDto }> {
    return { data: await this.affiliate.settleAffiliate(userId) };
  }
}
