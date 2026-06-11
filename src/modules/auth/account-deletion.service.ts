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
 * Strategy: anonymize-in-place. The User row survives (so posts/comments FK integrity
 * holds) but all PII is wiped and the account is tombstoned via `bannedAt`, which every
 * feed/search/profile query already filters on. The phone number is replaced with a
 * `deleted:{id}` tombstone so the person can sign up fresh with the same phone later.
 *
 * Realtime: clients receive a final `users:meUpdated` (reason `account_deleted`), then
 * all sessions are revoked and sockets disconnected.
 */
@Injectable()
export class AccountDeletionService {
  private readonly logger = new Logger(AccountDeletionService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly auth: AuthService,
    private readonly moduleRef: ModuleRef,
  ) {}

  async deleteAccount(userId: string, params?: { reason?: string | null; details?: string | null }): Promise<{ success: true }> {
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
      `[account-deletion] user=${id} reason=${reason || '(none)'} details=${details ? `${details.length} chars` : '(none)'}`,
    );

    // Cancel any active Stripe subscription first (best-effort — never blocks deletion).
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
        // Tombstone: every feed/search/profile surface already excludes bannedAt != null,
        // and banned phone tombstones cannot log back in.
        bannedAt: user.bannedAt ?? now,
        bannedReason: 'self_deleted',
      },
    });

    // Realtime: final me-update so other open tabs/devices reset, then hard-disconnect.
    const usersMeRealtime = this.moduleRef.get(UsersMeRealtimeService, { strict: false });
    usersMeRealtime?.emitMeUpdatedFromUser(updated, 'account_deleted');

    await this.auth.revokeAllSessionsForUser(id);

    const presenceRealtime = this.moduleRef.get(PresenceRealtimeService, { strict: false });
    presenceRealtime?.disconnectUserSockets(id);

    const publicProfileCache = this.moduleRef.get<PublicProfileCacheService<{ id: string; username: string | null }>>(
      PublicProfileCacheService,
      { strict: false },
    );
    try {
      await publicProfileCache?.invalidateForUser({ id, username: user.username ?? null });
    } catch {
      // Best-effort
    }

    return { success: true };
  }
}
