import { Injectable, Logger } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
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
      // Still mark any pending request approved when an admin is reviewing a queue item.
      if (params.requestId && params.adminUserId) {
        await this.markRequestApproved({
          requestId: params.requestId,
          adminUserId: params.adminUserId,
          adminNote: params.adminNote ?? null,
          now,
        }).catch(() => undefined);
        try {
          this.presenceRealtime.emitAdminUpdated(params.adminUserId, {
            kind: 'verification',
            action: 'reviewed',
            id: params.requestId,
          });
        } catch {
          // Best-effort
        }
      }
      return { verified: false, alreadyVerified: true, userId, previousUnverifiedAt };
    }

    await this.prisma.$transaction(async (tx) => {
      await tx.user.update({
        where: { id: userId },
        data: {
          verifiedStatus: status,
          verifiedAt: now,
          unverifiedAt: null,
        },
      });

      if (params.requestId && params.adminUserId) {
        await tx.verificationRequest.updateMany({
          where: { id: params.requestId, status: 'pending' },
          data: {
            status: 'approved',
            provider: 'manual',
            reviewedAt: now,
            reviewedByAdminId: params.adminUserId,
            adminNote: params.adminNote ?? null,
            rejectionReason: null,
          },
        });
      }

      // Clear any other stale pending requests for this user (e.g. auto-verify).
      await tx.verificationRequest.updateMany({
        where: {
          userId,
          status: 'pending',
          ...(params.requestId ? { id: { not: params.requestId } } : {}),
        },
        data: {
          status: 'approved',
          provider: 'manual',
          reviewedAt: now,
          ...(params.adminUserId ? { reviewedByAdminId: params.adminUserId } : {}),
          rejectionReason: null,
        },
      });
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
      if (params.adminUserId && params.requestId) {
        this.presenceRealtime.emitAdminUpdated(params.adminUserId, {
          kind: 'verification',
          action: 'reviewed',
          id: params.requestId,
        });
      }
      await this.usersPublicRealtime.emitPublicProfileUpdated(userId);
      void this.usersMeRealtime.emitMeUpdated(userId, 'verification_status_changed');
    } catch {
      // Best-effort
    }

    this.logger.log(`[verification] Verified user ${userId} via ${params.source}`);
    return { verified: true, alreadyVerified: false, userId, previousUnverifiedAt };
  }

  private async markRequestApproved(params: {
    requestId: string;
    adminUserId: string;
    adminNote: string | null;
    now: Date;
  }): Promise<void> {
    await this.prisma.verificationRequest.updateMany({
      where: { id: params.requestId, status: 'pending' },
      data: {
        status: 'approved',
        provider: 'manual',
        reviewedAt: params.now,
        reviewedByAdminId: params.adminUserId,
        adminNote: params.adminNote,
        rejectionReason: null,
      },
    });
  }
}
