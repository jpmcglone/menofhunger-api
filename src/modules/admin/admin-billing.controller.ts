import { Body, Controller, Get, NotFoundException, Param, Put, Req, UseGuards } from '@nestjs/common';
import { z } from 'zod';
import { AdminGuard, type AdminRequest } from './admin.guard';
import { EntitlementService } from '../billing/entitlement.service';
import { PrismaService } from '../prisma/prisma.service';
import { PublicProfileCacheService } from '../users/public-profile-cache.service';
import { UsersMeRealtimeService } from '../users/users-me-realtime.service';
import { UsersPublicRealtimeService } from '../users/users-public-realtime.service';
import { SlackService } from '../../common/slack/slack.service';
import type { AdminGrantSummaryDto } from '../../common/dto';

const setGrantsSchema = z.object({
  premiumMonths: z.number().int().min(0).max(1200).optional(),
  premiumPlusMonths: z.number().int().min(0).max(1200).optional(),
});

@UseGuards(AdminGuard)
@Controller('admin/users/:id/subscription-grants')
export class AdminBillingController {
  constructor(
    private readonly entitlement: EntitlementService,
    private readonly prisma: PrismaService,
    private readonly publicProfileCache: PublicProfileCacheService<{ id: string; username: string | null }>,
    private readonly usersMeRealtime: UsersMeRealtimeService,
    private readonly usersPublicRealtime: UsersPublicRealtimeService,
    private readonly slack: SlackService,
  ) {}

  private async requireUser(id: string) {
    const user = await this.prisma.user.findUnique({
      where: { id },
      select: { id: true, username: true, name: true, premium: true, premiumPlus: true },
    });
    if (!user) throw new NotFoundException('User not found.');
    return user;
  }

  /** Get the total banked free months per tier for a user. */
  @Get()
  async getGrantSummary(@Param('id') id: string): Promise<{ data: AdminGrantSummaryDto }> {
    await this.requireUser(id);
    const summary = await this.entitlement.getGrantSummary(id);
    return { data: summary };
  }

  /**
   * Set the total free months banked for a user.
   * Pass premiumMonths and/or premiumPlusMonths to update each tier independently.
   * Setting a tier to 0 clears all active grants for that tier.
   *
   * Each call consolidates existing grants into one, so the user ends up with exactly
   * the specified number of months remaining from now.
   */
  @Put()
  async setGrantMonths(
    @Req() req: AdminRequest,
    @Param('id') id: string,
    @Body() body: unknown,
  ): Promise<{ data: AdminGrantSummaryDto }> {
    const { premiumMonths, premiumPlusMonths } = setGrantsSchema.parse(body);
    const adminId = String(req.user?.id ?? '').trim() || null;

    const user = await this.requireUser(id);
    const hadPremium = user.premium;

    let lastEntitlement;

    if (premiumPlusMonths !== undefined) {
      lastEntitlement = await this.entitlement.setGrantMonths({
        userId: id,
        tier: 'premiumPlus',
        months: premiumPlusMonths,
        grantedByAdminId: adminId,
      });
    }

    if (premiumMonths !== undefined) {
      lastEntitlement = await this.entitlement.setGrantMonths({
        userId: id,
        tier: 'premium',
        months: premiumMonths,
        grantedByAdminId: adminId,
      });
    }

    if (lastEntitlement && !hadPremium && lastEntitlement.isPremium) {
      this.slack.notifyPremiumGranted({
        userId: id,
        username: user.username ?? null,
        name: user.name ?? null,
        tier: lastEntitlement.isPremiumPlus ? 'premiumPlus' : 'premium',
        source: 'admin',
      });
    }

    try {
      await this.publicProfileCache.invalidateForUser({ id, username: user.username ?? null });
      void this.usersPublicRealtime.emitPublicProfileUpdated(id);
      void this.usersMeRealtime.emitMeUpdated(id, 'billing_tier_changed');
    } catch {
      // Best-effort
    }

    const summary = await this.entitlement.getGrantSummary(id);
    return { data: summary };
  }
}
