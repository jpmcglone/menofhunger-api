import type { AccountDeletionRequestDto, AccountDeletionStatusDto } from '../../common/dto';
import { BadRequestException, Injectable, Logger, NotFoundException } from '@nestjs/common';
import { ModuleRef } from '@nestjs/core';
import { PrismaService } from '../prisma/prisma.service';
import { AuthService } from './auth.service';
import { PresenceRealtimeService } from '../presence/presence-realtime.service';
import { PublicProfileCacheService } from '../users/public-profile-cache.service';
import { UsersMeRealtimeService } from '../users/users-me-realtime.service';
import { BillingService } from '../billing/billing.service';
import { AdminImageReviewService } from '../admin/admin-image-review.service';
import { EmailService } from '../email/email.service';
import { RedisService } from '../redis/redis.service';
import { CacheInvalidationService } from '../redis/cache-invalidation.service';
import { eraseAccountRecords } from './account-erasure';

@Injectable()
export class AccountDeletionService {
  private readonly logger = new Logger(AccountDeletionService.name);
  constructor(private readonly prisma: PrismaService, private readonly auth: AuthService, private readonly moduleRef: ModuleRef) {}

  async requestDeletion(userId: string, _params?: { reason?: string | null; details?: string | null }): Promise<AccountDeletionRequestDto> {
    const now = new Date();
    const scheduledAt = new Date(now.getTime() + 30 * 86400000);
    const user = await this.prisma.user.findUnique({ where: { id: userId } });
    if (!user) throw new NotFoundException('User not found.');
    if (user.isBot || user.accountKind === 'page') throw new BadRequestException('Only personal accounts can use this flow.');
    const result = await this.prisma.$transaction(async tx => {
      const receipt = await tx.accountDeletionReceipt.upsert({
        where: { userId }, update: {},
        create: { userId, scheduledAt, expiresAt: new Date(scheduledAt.getTime() + 90 * 86400000),
          confirmationEmail: user.emailVerifiedAt ? user.email : null },
      });
      const updated = await tx.user.update({ where: { id: userId }, data: {
        bannedAt: now, bannedReason: 'self_deleted_pending', deletionRequestedAt: now, deletionScheduledAt: receipt.scheduledAt,
      } });
      return { receipt, updated };
    });
    this.moduleRef.get(UsersMeRealtimeService, { strict: false }).emitMeUpdatedFromUser(result.updated, 'account_deleted');
    await this.auth.revokeAllSessionsForUser(userId);
    this.moduleRef.get(PresenceRealtimeService, { strict: false }).disconnectUserSockets(userId);
    await this.moduleRef.get(PublicProfileCacheService, { strict: false }).invalidateForUser(user);
    return { success: true as const, deletionScheduledAt: result.receipt.scheduledAt.toISOString(), deletionStatusToken: result.receipt.id };
  }

  async status(token: string): Promise<AccountDeletionStatusDto> {
    const receipt = await this.prisma.accountDeletionReceipt.findUnique({ where: { id: token } });
    if (!receipt || receipt.expiresAt < new Date()) throw new NotFoundException('This deletion receipt is unavailable or has expired.');
    return { status: receipt.cancelledAt ? 'cancelled' : receipt.completedAt ? 'completed' : receipt.startedAt ? 'processing' : 'scheduled',
      scheduledAt: receipt.scheduledAt.toISOString(), completedAt: receipt.completedAt?.toISOString() ?? null };
  }

  async finalizeDueDeletions(limit = 100): Promise<{ finalized: number }> {
    const now = new Date();
    // Backfill requests scheduled by older app versions before receipts existed.
    const pending = await this.prisma.user.findMany({ where: { bannedReason: 'self_deleted_pending', deletionScheduledAt: { lte: now } }, take: limit });
    for (const user of pending) await this.prisma.accountDeletionReceipt.upsert({ where: { userId: user.id }, update: {}, create: {
      userId: user.id, scheduledAt: user.deletionScheduledAt!, expiresAt: new Date(now.getTime() + 90 * 86400000),
      confirmationEmail: user.emailVerifiedAt ? user.email : null,
    } });
    const receipts = await this.prisma.accountDeletionReceipt.findMany({
      where: { completedAt: null, cancelledAt: null, scheduledAt: { lte: now } }, orderBy: { scheduledAt: 'asc' }, take: limit,
    });
    let finalized = 0;
    for (const receipt of receipts) {
      try { if (await this.finalizeReceipt(receipt.id)) finalized++; }
      catch { this.logger.warn(`Account erasure will retry receipt=${receipt.id}`); }
    }
    await this.prisma.accountDeletionReceipt.deleteMany({ where: { expiresAt: { lt: now }, OR: [{ completedAt: { not: null } }, { cancelledAt: { not: null } }] } });
    return { finalized };
  }

  async finalizeDeletion(userId: string): Promise<boolean> {
    const receipt = await this.prisma.accountDeletionReceipt.findUnique({ where: { userId } });
    return receipt ? this.finalizeReceipt(receipt.id) : false;
  }

  private async finalizeReceipt(receiptId: string): Promise<boolean> {
    return await this.moduleRef.get(RedisService, { strict: false }).withLock(
      `account-erasure:${receiptId}`, { ttlMs: 15 * 60_000 }, () => this.eraseReceipt(receiptId),
    ) ?? false;
  }

  private async eraseReceipt(receiptId: string): Promise<boolean> {
    let receipt = await this.prisma.accountDeletionReceipt.findUniqueOrThrow({ where: { id: receiptId } });
    const now = new Date();
    if (receipt.cancelledAt || receipt.completedAt || receipt.scheduledAt > now || !receipt.userId) return false;
    const userId = receipt.userId;
    if (!receipt.startedAt) {
      // Claim atomically against login cancellation; after this point restoration is refused.
      const claimed = await this.prisma.$transaction(async tx => {
        const claim = await tx.user.updateMany({ where: { id: userId, bannedReason: 'self_deleted_pending', deletionScheduledAt: { lte: now } }, data: { bannedReason: 'self_deleted_erasing' } });
        if (!claim.count) return false;
        await tx.accountDeletionReceipt.update({ where: { id: receiptId }, data: { startedAt: now } });
        return true;
      });
      if (!claimed) return false;
    }
    const media = this.moduleRef.get(AdminImageReviewService, { strict: false });
    if (!receipt.erasedAt) {
      // External work runs in the scheduled worker, not in the deletion request.
      // Failures remain durable and retry; never claim completion after partial cleanup.
      await this.moduleRef.get(BillingService, { strict: false }).cancelSubscriptionForAccountDeletion(userId);
      const keys = await media.accountErasureKeys(userId);
      receipt = await this.prisma.accountDeletionReceipt.update({ where: { id: receiptId }, data: { mediaKeys: keys } });
      const user = await this.prisma.user.findUnique({ where: { id: userId }, select: { username: true } });
      await this.prisma.$transaction(async tx => {
        await eraseAccountRecords(tx, userId);
        await tx.accountDeletionReceipt.update({ where: { id: receiptId }, data: { erasedAt: new Date() } });
      }, { timeout: 60000 });
      await this.moduleRef.get(PublicProfileCacheService, { strict: false }).invalidateForUser({ id: userId, username: user?.username ?? null });
    }
    await this.moduleRef.get(PublicProfileCacheService, { strict: false }).invalidateForUser({ id: userId, username: null });
    await media.eraseUnreferencedAccountMedia(receipt.mediaKeys);
    // Invalidate derived content, including summaries generated before erasure.
    const redis = this.moduleRef.get(RedisService, { strict: false }).raw();
    for (const pattern of ['marv:catchup:*', `profile:*${userId}*`, `marv:*${userId}*`]) {
      let cursor = '0';
      do { const result = await redis.scan(cursor, 'MATCH', pattern, 'COUNT', 100); cursor = result[0];
        if (result[1].length) await redis.del(...result[1]);
      } while (cursor !== '0');
    }
    const cache = this.moduleRef.get(CacheInvalidationService, { strict: false });
    await cache.bumpFeedGlobal();
    await cache.bumpSearchGlobal();
    if (receipt.confirmationEmail) {
      const result = await this.moduleRef.get(EmailService, { strict: false }).sendText({ to: receipt.confirmationEmail,
        subject: 'Your Men of Hunger account has been deleted',
        text: 'Your account and associated personal content and fitness data have been deleted. Apple subscriptions are managed separately in your Apple subscription settings. Contact hello@menofhunger.com if you need help.', category: 'transactional' });
      if (!result.sent) throw new Error('Deletion confirmation will retry.');
    }
    await this.prisma.accountDeletionReceipt.update({ where: { id: receiptId }, data: {
      completedAt: new Date(), userId: null, confirmationEmail: null, mediaKeys: [],
    } });
    return true;
  }
}
