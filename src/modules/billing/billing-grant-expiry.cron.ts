import { Injectable, Logger } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import { PrismaService } from '../prisma/prisma.service';
import { AppConfigService } from '../app/app-config.service';
import { EntitlementService } from './entitlement.service';
import { PublicProfileCacheService } from '../users/public-profile-cache.service';
import { UsersMeRealtimeService } from '../users/users-me-realtime.service';
import { UsersPublicRealtimeService } from '../users/users-public-realtime.service';

@Injectable()
export class BillingGrantExpiryCron {
  private readonly logger = new Logger(BillingGrantExpiryCron.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly appConfig: AppConfigService,
    private readonly entitlement: EntitlementService,
    private readonly publicProfileCache: PublicProfileCacheService<{ id: string; username: string | null }>,
    private readonly usersMeRealtime: UsersMeRealtimeService,
    private readonly usersPublicRealtime: UsersPublicRealtimeService,
  ) {}

  /**
   * Every 30 minutes: find users whose grant just expired and re-resolve their
   * effective tier. Without this, a user whose only entitlement was a grant
   * would remain premium indefinitely after the grant window closes.
   *
   * Uses a 2-hour lookback so any run missed due to a restart is caught on the
   * next tick.
   */
  @Cron('*/30 * * * *')
  async expireGrants() {
    if (!this.appConfig.runSchedulers()) return;

    const now = new Date();
    const lookback = new Date(now.getTime() - 2 * 60 * 60 * 1000);

    // Find users whose grants recently expired AND who are still marked premium.
    // We only care about users who might need to lose access.
    const rows = await this.prisma.subscriptionGrant.findMany({
      where: {
        revokedAt: null,
        endsAt: { gte: lookback, lt: now },
        user: { premium: true },
      },
      select: { userId: true },
      distinct: ['userId'],
    });

    if (rows.length === 0) return;

    this.logger.log(`[grant-expiry] Recomputing entitlement for ${rows.length} user(s) with recently expired grants`);

    for (const row of rows) {
      try {
        const before = await this.prisma.user.findUnique({
          where: { id: row.userId },
          select: { username: true, premium: true, premiumPlus: true },
        });

        const result = await this.entitlement.recomputeAndApply(row.userId);

        const wasDowngraded = before?.premium && !result.isPremium;

        if (wasDowngraded) {
          this.logger.log(`[grant-expiry] User ${row.userId} downgraded from premium — grant expired`);
          try {
            await this.publicProfileCache.invalidateForUser({
              id: row.userId,
              username: before?.username ?? null,
            });
            void this.usersPublicRealtime.emitPublicProfileUpdated(row.userId);
            void this.usersMeRealtime.emitMeUpdated(row.userId, 'billing_tier_changed');
          } catch {
            // Best-effort
          }
        }
      } catch (err) {
        this.logger.warn(`[grant-expiry] Failed to recompute for user ${row.userId}: ${err}`);
      }
    }
  }
}
