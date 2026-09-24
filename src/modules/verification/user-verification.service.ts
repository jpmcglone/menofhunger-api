import { PosthogService } from '../../common/posthog/posthog.service';
import { Injectable, Logger } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { AuthService } from '../auth/auth.service';
import { BillingService } from '../billing/billing.service';
import { AffiliateService } from '../billing/affiliate.service';
import { CoinsService } from '../coins/coins.service';
import { SideEffectsService } from '../side-effects/side-effects.service';
import { PublicProfileCacheService } from '../users/public-profile-cache.service';
import { UsersMeRealtimeService } from '../users/users-me-realtime.service';
import { UsersPublicRealtimeService } from '../users/users-public-realtime.service';
import { PresenceRealtimeService } from '../presence/presence-realtime.service';

export type VerifyUserSource = 'admin_request' | 'admin_patch' | 'auto_referral' | 'auto_signup';

export type VerifyUserResult = {
  verified: boolean;
  alreadyVerified: boolean;
  userId: string;
  previousUnverifiedAt: Date | null;
};

/**
 * Single path for badge verification. All admin approve / admin patch / auto-verify
 * flows go through here so coins, affiliate earnings, billing, notifications, and
 * realtime updates stay consistent.
 */
@Injectable()
export class UserVerificationService {
  private readonly logger = new Logger(UserVerificationService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly billing: BillingService,
    private readonly affiliate: AffiliateService,
    private readonly coins: CoinsService,
    private readonly sideEffects: SideEffectsService,
    private readonly publicProfileCache: PublicProfileCacheService<{ id: string; username: string | null }>,
    private readonly usersMeRealtime: UsersMeRealtimeService,
    private readonly usersPublicRealtime: UsersPublicRealtimeService,
    private readonly presenceRealtime: PresenceRealtimeService,
    private readonly posthog: PosthogService,
    private readonly auth: AuthService,
  ) {}

  async verifyUser(params: {
    userId: string;
    source: VerifyUserSource;
    /** When approving a specific request, mark that request (and any other pending) approved. */
    requestId?: string | null;
    adminUserId?: string | null;
    adminNote?: string | null;
    /** Override verifiedStatus (admin_patch may set identity vs manual). Default: manual. */
    verifiedStatus?: 'identity' | 'manual';
  }): Promise<VerifyUserResult> {
    const userId = (params.userId ?? '').trim();
    if (!userId) {
      return { verified: false, alreadyVerified: false, userId: '', previousUnverifiedAt: null };
    }

    const now = new Date();
    const status = params.verifiedStatus ?? 'manual';

    const current = await this.prisma.user.findUnique({
      where: { id: userId },
      select: {
        id: true,
        username: true,
        verifiedStatus: true,
        unverifiedAt: true,
      },
    });
    if (!current) {
      return { verified: false, alreadyVerified: false, userId, previousUnverifiedAt: null };
    }

    const alreadyVerified = (current.verifiedStatus ?? 'none') !== 'none';
    const previousUnverifiedAt = current.unverifiedAt ?? null;

    if (alreadyVerified) {
      await this.prisma.verificationRequest.updateMany({
        where: { userId, status: 'pending' },
        data: {
          status: 'approved', reviewedAt: now, rejectionReason: null,
          ...(params.adminUserId ? { reviewedByAdminId: params.adminUserId } : {}),
          ...(params.adminNote != null ? { adminNote: params.adminNote } : {}),
        },
      });
      await this.auth.bustSessionCachesForUser(userId);
      await this.notifyMemberChanged(userId);
      await this.notifyAdminQueueChanged('reviewed', params.requestId);
      return { verified: false, alreadyVerified: true, userId, previousUnverifiedAt };
    }

    const newlyVerified = await this.prisma.$transaction(async (tx) => {
      // Only one concurrent approval owns rewards and notifications.
      const changed = await tx.user.updateMany({
        where: { id: userId, verifiedStatus: 'none' },
        data: {
          verifiedStatus: status,
          verifiedAt: now,
          unverifiedAt: null,
        },
      });

      // Verification resolves every pending request, regardless of the entry point.
      // Preserve the original provider so the video-call agreement remains auditable.
      await tx.verificationRequest.updateMany({
        where: { userId, status: 'pending' },
        data: {
          status: 'approved',
          reviewedAt: now,
          ...(params.adminUserId ? { reviewedByAdminId: params.adminUserId } : {}),
          ...(params.adminNote != null ? { adminNote: params.adminNote } : {}),
          rejectionReason: null,
        },
      });
      return changed.count > 0;
    });

    // Guards seed posting permissions from the cached session. Clear every device's
    // snapshot before telling the member verification has unlocked their account.
    await this.auth.bustSessionCachesForUser(userId);
    await this.notifyMemberChanged(userId);

    if (!newlyVerified) {
      await this.notifyAdminQueueChanged('reviewed', params.requestId);
      return { verified: false, alreadyVerified: true, userId, previousUnverifiedAt };
    }

    this.posthog.capture(userId, 'verification_approved', {
      source: params.source, $insert_id: `verification-approved:${userId}:${now.toISOString()}`,
    });

    try {
      await this.publicProfileCache.invalidateForUser({
        id: current.id,
        username: current.username ?? null,
      });
    } catch {
      // Best-effort
    }

    try {
      await this.billing.onUserVerified(userId, previousUnverifiedAt);
    } catch (err) {
      this.logger.warn(`Failed to run billing hooks for verified user ${userId}: ${err}`);
    }

    try {
      await this.coins.giftVerificationCoins(userId, 5);
    } catch (err) {
      this.logger.warn(`Failed to gift verification coins for user ${userId}: ${err}`);
    }

    try {
      await this.affiliate.maybeRecordEarning(userId, 'verified');
    } catch (err) {
      this.logger.warn(`[affiliate] Failed to record verified earning for user ${userId}: ${err}`);
    }

    this.sideEffects.dispatch('user.verified', { userId });

    try {
      await this.notifyAdminQueueChanged('reviewed', params.requestId);
      await this.usersPublicRealtime.emitPublicProfileUpdated(userId);
    } catch {
      // Best-effort
    }

    this.logger.log(`[verification] Verified user ${userId} via ${params.source}`);
    return { verified: true, alreadyVerified: false, userId, previousUnverifiedAt };
  }

  /** Invalidate member progress even when a request changes but the badge does not. */
  async notifyMemberChanged(userId: string): Promise<void> {
    try {
      await this.usersMeRealtime.emitMeUpdated(userId, 'verification_status_changed');
    } catch (error) {
      this.logger.warn(`Could not refresh member verification state: ${error}`);
    }
  }

  /** Every admin sees queue changes, including approvals outside the request screen. */
  async notifyAdminQueueChanged(action: 'created' | 'reviewed', requestId?: string | null): Promise<void> {
    try {
      const admins = await this.prisma.user.findMany({
        where: { siteAdmin: true, bannedAt: null }, select: { id: true },
      });
      for (const admin of admins) {
        this.presenceRealtime.emitAdminUpdated(admin.id, {
          kind: 'verification', action, ...(requestId ? { id: requestId } : {}),
        });
      }
    } catch (error) {
      this.logger.warn(`Could not refresh verification queue: ${error}`);
    }
  }
}
