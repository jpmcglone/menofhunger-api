import { Body, Controller, Delete, Get, NotFoundException, Param, Post, Req, UseGuards } from '@nestjs/common';
import { z } from 'zod';
import { AdminGuard, type AdminRequest } from './admin.guard';
import { EntitlementService } from '../billing/entitlement.service';
import { PrismaService } from '../prisma/prisma.service';
import { PublicProfileCacheService } from '../users/public-profile-cache.service';
import { UsersMeRealtimeService } from '../users/users-me-realtime.service';
import { UsersPublicRealtimeService } from '../users/users-public-realtime.service';
import { SlackService } from '../../common/slack/slack.service';
import type { AdminGrantMonthsDto, AdminSubscriptionGrantDto } from '../../common/dto';

const grantSchema = z.object({
  tier: z.enum(['premium', 'premiumPlus']),
  months: z.number().int().min(1).max(24),
  reason: z.string().trim().max(500).optional(),
});

function toAdminGrantDto(g: {
  id: string;
  tier: string;
  source: string;
  months: number;
  startsAt: Date;
  endsAt: Date;
  reason: string | null;
  grantedByAdminId: string | null;
  createdAt: Date;
}): AdminSubscriptionGrantDto {
  return {
    id: g.id,
    tier: g.tier as 'premium' | 'premiumPlus',
    source: g.source as 'admin' | 'referral',
    months: g.months,
    startsAt: g.startsAt.toISOString(),
    endsAt: g.endsAt.toISOString(),
    reason: g.reason,
    grantedByAdminId: g.grantedByAdminId,
    createdAt: g.createdAt.toISOString(),
  };
}

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
      select: { id: true, username: true, name: true, premium: true, premiumPlus: true, verifiedStatus: true },
    });
    if (!user) throw new NotFoundException('User not found.');
    return user;
  }

  /** List all grants (including revoked/expired) for a user. */
  @Get()
  async listGrants(@Param('id') id: string) {
    await this.requireUser(id);
    const grants = await this.entitlement.getAllGrants(id);
    return { data: grants.map(toAdminGrantDto) };
  }

  /**
   * Grant N free months of Premium or Premium+ to a user.
   * Grants stack: each grant starts from the latest existing grant's end date,
   * so calling this multiple times accumulates months cleanly.
   */
  @Post()
  async grantMonths(@Req() req: AdminRequest, @Param('id') id: string, @Body() body: unknown) {
    const { tier, months, reason } = grantSchema.parse(body);
    const adminId = String(req.user?.id ?? '').trim();

    const user = await this.requireUser(id);

    const { grant, entitlement } = await this.entitlement.grantMonths({
      userId: id,
      tier,
      months,
      source: 'admin',
      grantedByAdminId: adminId || null,
      reason: reason ?? null,
    });

    // Notify if this elevated the user's tier.
    if (!user.premium && entitlement.isPremium) {
      this.slack.notifyPremiumGranted({
        userId: id,
        username: user.username ?? null,
        name: user.name ?? null,
        tier: entitlement.isPremiumPlus ? 'premiumPlus' : 'premium',
        source: 'admin',
      });
    }

    // Push realtime updates to the user's devices.
    try {
      await this.publicProfileCache.invalidateForUser({ id, username: user.username ?? null });
      void this.usersPublicRealtime.emitPublicProfileUpdated(id);
      void this.usersMeRealtime.emitMeUpdated(id, 'billing_tier_changed');
    } catch {
      // Best-effort
    }

    const allGrants = await this.entitlement.getAllGrants(id);
    const result: AdminGrantMonthsDto = {
      grants: allGrants.map(toAdminGrantDto),
      effectiveExpiresAt: entitlement.effectiveExpiresAt ? entitlement.effectiveExpiresAt.toISOString() : null,
    };

    return { data: result };
  }

  /** Revoke an active grant. The user's effective tier is recomputed immediately. */
  @Delete(':grantId')
  async revokeGrant(@Param('id') id: string, @Param('grantId') grantId: string) {
    const user = await this.requireUser(id);

    const entitlement = await this.entitlement.revokeGrant({ grantId, userId: id });

    try {
      await this.publicProfileCache.invalidateForUser({ id, username: user.username ?? null });
      void this.usersPublicRealtime.emitPublicProfileUpdated(id);
      void this.usersMeRealtime.emitMeUpdated(id, 'billing_tier_changed');
    } catch {
      // Best-effort
    }

    const allGrants = await this.entitlement.getAllGrants(id);
    const result: AdminGrantMonthsDto = {
      grants: allGrants.map(toAdminGrantDto),
      effectiveExpiresAt: entitlement.effectiveExpiresAt ? entitlement.effectiveExpiresAt.toISOString() : null,
    };

    return { data: result };
  }
}
