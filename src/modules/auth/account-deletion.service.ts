import { BadRequestException, Injectable, Logger, NotFoundException } from '@nestjs/common';
import { ModuleRef } from '@nestjs/core';
import { PrismaService } from '../prisma/prisma.service';
import { AuthService } from './auth.service';
import { PresenceRealtimeService } from '../presence/presence-realtime.service';
import { PublicProfileCacheService } from '../users/public-profile-cache.service';
import { UsersMeRealtimeService } from '../users/users-me-realtime.service';
import { BillingService } from '../billing/billing.service';

/**
 * Self-service account deletion (App Store Guideline 5.1.1(v)).
 *
 * Strategy: mark now, anonymize later. Requesting deletion immediately hides the
 * account via `bannedAt`, revokes sessions, and disconnects sockets, but PII is kept
 * for a 30-day grace period. Logging in with the same phone during that window cancels
 * deletion. After the grace period, the finalize sweep wipes PII in place while keeping
 * the User row for FK integrity.
 *
 * Realtime: clients receive a final `users:meUpdated` (reason `account_deleted`), then
 * all sessions are revoked and sockets disconnected.
 */
@Injectable()
export class AccountDeletionService {
  private static readonly pendingReason = 'self_deleted_pending';
  private static readonly finalizedReason = 'self_deleted';
  private static readonly gracePeriodMs = 30 * 24 * 60 * 60_000;

  private readonly logger = new Logger(AccountDeletionService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly auth: AuthService,
    private readonly moduleRef: ModuleRef,
  ) {}

  async requestDeletion(
    userId: string,
    params?: { reason?: string | null; details?: string | null },
  ): Promise<{ success: true; deletionScheduledAt: string }> {
    const id = String(userId ?? '').trim();
    if (!id) throw new NotFoundException('User not found.');

    const user = await this.prisma.user.findUnique({
      where: { id },
      select: { id: true, username: true, isBot: true, bannedAt: true },
    });
    if (!user) throw new NotFoundException('User not found.');
    if (user.isBot) throw new BadRequestException('Bot accounts cannot be deleted.');

    const reason = (params?.reason ?? '').trim();
    const details = (params?.details ?? '').trim();
    this.logger.log(
      `[account-deletion] requested user=${id} reason=${reason || '(none)'} details=${details ? `${details.length} chars` : '(none)'}`,
    );

    const now = new Date();
    const deletionScheduledAt = new Date(now.getTime() + AccountDeletionService.gracePeriodMs);
    const updated = await this.prisma.user.update({
      where: { id },
      data: {
        bannedAt: user.bannedAt ?? now,
        bannedReason: AccountDeletionService.pendingReason,
        deletionRequestedAt: now,
        deletionScheduledAt,
      },
    });

    // Realtime: final me-update so other open tabs/devices reset, then hard-disconnect.
    const usersMeRealtime = this.moduleRef.get(UsersMeRealtimeService, { strict: false });
    usersMeRealtime?.emitMeUpdatedFromUser(updated, 'account_deleted');

    await this.auth.revokeAllSessionsForUser(id);

    const presenceRealtime = this.moduleRef.get(PresenceRealtimeService, { strict: false });
    presenceRealtime?.disconnectUserSockets(id);

    await this.invalidatePublicProfile(user);

    return { success: true, deletionScheduledAt: deletionScheduledAt.toISOString() };
  }

  async finalizeDueDeletions(limit = 100): Promise<{ finalized: number }> {
    const now = new Date();
    const users = await this.prisma.user.findMany({
      where: {
        bannedReason: AccountDeletionService.pendingReason,
        deletionScheduledAt: { lte: now },
      },
      select: { id: true },
      take: limit,
      orderBy: { deletionScheduledAt: 'asc' },
    });

    let finalized = 0;
    for (const user of users) {
      const ok = await this.finalizeDeletion(user.id);
      if (ok) finalized += 1;
    }

    return { finalized };
  }

  async finalizeDeletion(userId: string): Promise<boolean> {
    const id = String(userId ?? '').trim();
    if (!id) return false;

    const user = await this.prisma.user.findUnique({
      where: { id },
      select: { id: true, username: true, isBot: true, bannedAt: true, bannedReason: true },
    });
    if (!user || user.isBot || user.bannedReason !== AccountDeletionService.pendingReason) {
      return false;
    }

    // Cancel any active Stripe subscription first (best-effort — never blocks finalization).
    const billing = this.moduleRef.get(BillingService, { strict: false });
    await billing?.cancelSubscriptionForAccountDeletion(id);

    const now = new Date();
    const updated = await this.prisma.user.update({
      where: { id },
      data: {
        // PII wipe. Phone is unique — tombstone it so the number can be reused.
        phone: `deleted:${id}`,
        email: null,
        emailVerifiedAt: null,
        emailVerificationRequestedAt: null,
        username: null,
        usernameIsSet: false,
        name: null,
        bio: null,
        website: null,
        locationInput: null,
        locationDisplay: null,
        locationZip: null,
        locationCity: null,
        locationCounty: null,
        locationState: null,
        locationCountry: null,
        birthdate: null,
        interests: [],
        avatarKey: null,
        avatarUpdatedAt: now,
        bannerKey: null,
        bannerUpdatedAt: now,
        pinnedPostId: null,
        // Final tombstone: every feed/search/profile surface already excludes bannedAt != null,
        // and finalized phone tombstones cannot log back in.
        bannedAt: user.bannedAt ?? now,
        bannedReason: AccountDeletionService.finalizedReason,
        deletionRequestedAt: null,
        deletionScheduledAt: null,
      },
    });

    await this.auth.revokeAllSessionsForUser(id);

    const presenceRealtime = this.moduleRef.get(PresenceRealtimeService, { strict: false });
    presenceRealtime?.disconnectUserSockets(id);

    await this.invalidatePublicProfile({ id, username: user.username ?? null });
    this.logger.log(`[account-deletion] finalized user=${id}`);

    return Boolean(updated);
  }

  private async invalidatePublicProfile(user: { id: string; username: string | null }): Promise<void> {
    const publicProfileCache = this.moduleRef.get<PublicProfileCacheService<{ id: string; username: string | null }>>(PublicProfileCacheService, {
      strict: false,
    });
    try {
      await publicProfileCache?.invalidateForUser(user);
    } catch {
      // Best-effort
    }
  }
}
