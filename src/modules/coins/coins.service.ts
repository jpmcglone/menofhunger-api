import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { z } from 'zod';
import { PrismaService } from '../prisma/prisma.service';
import { AppConfigService } from '../app/app-config.service';
import { NotificationsService } from '../notifications/notifications.service';
import { UsersMeRealtimeService } from '../users/users-me-realtime.service';
import { publicAssetUrl } from '../../common/assets/public-asset-url';
import { createdAtIdCursorWhere } from '../../common/pagination/created-at-id-cursor';
import type { CoinTransferDto, CoinTransferReceiptDto, TransferCoinsResponse } from '../../common/dto/coin-transfer.dto';

export const transferCoinsSchema = z.object({
  recipientUsername: z.string().trim().min(1),
  amount: z.number().int().min(1, 'Amount must be at least 1'),
  note: z.string().trim().max(140).optional().nullable(),
});

const COUNTERPARTY_SELECT = {
  id: true,
  username: true,
  name: true,
  avatarKey: true,
  avatarUpdatedAt: true,
  bannedAt: true,
  verifiedStatus: true,
} as const;

@Injectable()
export class CoinsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly appConfig: AppConfigService,
    private readonly notifications: NotificationsService,
    private readonly usersMeRealtime: UsersMeRealtimeService,
  ) {}

  private async assertCoinsAccess(userId: string) {
    const user = await this.prisma.user.findUnique({
      where: { id: userId },
      select: { id: true, verifiedStatus: true },
    });
    if (!user) throw new NotFoundException('User not found.');
    if (user.verifiedStatus === 'none') {
      throw new BadRequestException('Verify your account to use coins.');
    }
    return user;
  }

  async transfer(params: {
    senderUserId: string;
    recipientUsername: string;
    amount: number;
    note?: string | null;
  }): Promise<TransferCoinsResponse> {
    const { senderUserId, recipientUsername, amount, note } = params;
    await this.assertCoinsAccess(senderUserId);

    const recipient = await this.prisma.user.findFirst({
      where: { username: { equals: recipientUsername, mode: 'insensitive' } },
      select: COUNTERPARTY_SELECT,
    });

    if (!recipient) throw new NotFoundException('User not found.');
    if (recipient.bannedAt) throw new BadRequestException('Cannot send coins to this user.');
    if (recipient.verifiedStatus === 'none') throw new BadRequestException('Cannot send coins to unverified users.');
    if (recipient.id === senderUserId) throw new BadRequestException('You cannot send coins to yourself.');

    const { senderAfter, transfer } = await this.prisma.$transaction(async (tx) => {
      const sender = await tx.user.findUnique({
        where: { id: senderUserId },
        select: { id: true, coins: true },
      });
      if (!sender) throw new NotFoundException('Sender not found.');
      if (sender.coins < amount) throw new BadRequestException('Insufficient coins.');

      const [senderAfter] = await Promise.all([
        tx.user.update({
          where: { id: senderUserId },
          data: { coins: { decrement: amount } },
          select: { coins: true },
        }),
        tx.user.update({
          where: { id: recipient.id },
          data: { coins: { increment: amount } },
        }),
      ]);

      const transfer = await tx.coinTransfer.create({
        data: {
          senderId: senderUserId,
          recipientId: recipient.id,
          kind: 'transfer',
          amount,
          note: note ?? undefined,
        },
      });

      return { senderAfter, transfer };
    });

    // Emit realtime balance updates to both parties (best-effort).
    await Promise.allSettled([
      this.usersMeRealtime.emitMeUpdated(senderUserId, 'coin_transfer_sent'),
      this.usersMeRealtime.emitMeUpdated(recipient.id, 'coin_transfer_received'),
    ]);

    // Notify recipient.
    const amountLabel = amount === 1 ? '1 coin' : `${amount} coins`;
    await this.notifications.create({
      recipientUserId: recipient.id,
      kind: 'coin_transfer',
      actorUserId: senderUserId,
      title: `sent you ${amountLabel}`,
      body: note ?? null,
    });

    return {
      transferId: transfer.id,
      amount,
      recipientUsername: recipient.username ?? recipientUsername,
      senderBalanceAfter: senderAfter.coins,
    };
  }

  async adminAdjustCoins(params: {
    adminUserId: string;
    targetUserId: string;
    delta: number;
    reason?: string | null;
  }): Promise<{ transferId: string; targetUserId: string; delta: number; targetBalanceAfter: number }> {
    const { adminUserId, targetUserId, delta, reason } = params;
    const deltaInt = Math.trunc(Number(delta));
    if (!Number.isFinite(deltaInt) || deltaInt === 0) {
      throw new BadRequestException('Adjustment must be a non-zero integer.');
    }
    const amount = Math.abs(deltaInt);

    const [adminExists, target] = await Promise.all([
      this.prisma.user.findUnique({
        where: { id: adminUserId },
        select: { id: true },
      }),
      this.prisma.user.findUnique({
        where: { id: targetUserId },
        select: { id: true, username: true, name: true, coins: true },
      }),
    ]);
    if (!adminExists) throw new NotFoundException('Admin user not found.');
    if (!target) throw new NotFoundException('Target user not found.');

    const note = (reason ?? '').trim() || null;

    const { transfer, targetAfter } = await this.prisma.$transaction(async (tx) => {
      if (deltaInt < 0 && target.coins < amount) {
        throw new BadRequestException('Cannot remove more coins than the user has.');
      }

      const targetAfter = await tx.user.update({
        where: { id: targetUserId },
        data: deltaInt > 0
          ? { coins: { increment: amount } }
          : { coins: { decrement: amount } },
        select: { coins: true },
      });

      const transfer = await tx.coinTransfer.create({
        data: {
          // For adds: admin -> user. For removals: user -> admin.
          senderId: deltaInt > 0 ? adminUserId : targetUserId,
          recipientId: deltaInt > 0 ? targetUserId : adminUserId,
          kind: 'admin_adjust',
          amount,
          note,
        },
      });

      return { transfer, targetAfter };
    });

    await this.usersMeRealtime.emitMeUpdated(targetUserId, 'coin_admin_adjusted').catch(() => undefined);

    return {
      transferId: transfer.id,
      targetUserId,
      delta: deltaInt,
      targetBalanceAfter: targetAfter.coins,
    };
  }

  async listTransfers(params: {
    userId: string;
    cursor?: string | null;
    limit?: number;
  }): Promise<{ items: CoinTransferDto[]; nextCursor: string | null }> {
    const { userId, cursor, limit = 20 } = params;
    await this.assertCoinsAccess(userId);
    const take = Math.min(Math.max(1, limit), 50);

    const cursorWhere = await createdAtIdCursorWhere({
      cursor: cursor ?? null,
      lookup: async (id) =>
        this.prisma.coinTransfer
          .findUnique({ where: { id }, select: { id: true, createdAt: true } })
          .then((r) => (r ? { id: r.id, createdAt: r.createdAt } : null)),
    });

    const transfers = await this.prisma.coinTransfer.findMany({
      where: {
        OR: [{ senderId: userId }, { recipientId: userId }],
        ...(cursorWhere ?? {}),
      },
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      take: take + 1,
      select: {
        id: true,
        createdAt: true,
        kind: true,
        amount: true,
        note: true,
        senderId: true,
        recipientId: true,
        sender: { select: COUNTERPARTY_SELECT },
        recipient: { select: COUNTERPARTY_SELECT },
      },
    });

    const hasNext = transfers.length > take;
    const page = hasNext ? transfers.slice(0, take) : transfers;

    const publicBaseUrl = this.appConfig.r2()?.publicBaseUrl ?? null;

    const items: CoinTransferDto[] = page.map((t) => {
      if (t.kind === 'admin_adjust') {
        const adminAdded = t.recipientId === userId;
        const counterparty = adminAdded ? t.sender : t.recipient;
        return {
          id: t.id,
          createdAt: t.createdAt.toISOString(),
          amount: t.amount,
          note: t.note ?? null,
          direction: adminAdded ? 'admin_added' : 'admin_removed',
          counterparty: {
            userId: counterparty.id,
            username: counterparty.username ?? '',
            displayName: counterparty.name ?? null,
            avatarUrl: publicAssetUrl({
              publicBaseUrl,
              key: counterparty.avatarKey,
              updatedAt: counterparty.avatarUpdatedAt ?? null,
            }),
          },
        };
      }

      const isSender = t.senderId === userId;
      const counterparty = isSender ? t.recipient : t.sender;
      return {
        id: t.id,
        createdAt: t.createdAt.toISOString(),
        amount: t.amount,
        note: t.note ?? null,
        direction: isSender ? 'sent' : 'received',
        counterparty: {
          userId: counterparty.id,
          username: counterparty.username ?? '',
          displayName: counterparty.name ?? null,
          avatarUrl: publicAssetUrl({
            publicBaseUrl,
            key: counterparty.avatarKey,
            updatedAt: counterparty.avatarUpdatedAt ?? null,
          }),
        },
      };
    });

    const lastItem = page[page.length - 1];
    const nextCursor = hasNext && lastItem ? lastItem.id : null;

    return { items, nextCursor };
  }

  async getTransferReceipt(params: { userId: string; transferId: string }): Promise<CoinTransferReceiptDto> {
    const { userId, transferId } = params;
    await this.assertCoinsAccess(userId);

    const transfer = await this.prisma.coinTransfer.findFirst({
      where: {
        id: transferId,
        OR: [{ senderId: userId }, { recipientId: userId }],
      },
      select: {
        id: true,
        createdAt: true,
        kind: true,
        amount: true,
        note: true,
        senderId: true,
        recipientId: true,
        sender: { select: COUNTERPARTY_SELECT },
        recipient: { select: COUNTERPARTY_SELECT },
      },
    });

    if (!transfer) throw new NotFoundException('Transfer not found.');

    const publicBaseUrl = this.appConfig.r2()?.publicBaseUrl ?? null;
    const sender = {
      userId: transfer.sender.id,
      username: transfer.sender.username ?? null,
      displayName: transfer.sender.name ?? null,
      avatarUrl: publicAssetUrl({
        publicBaseUrl,
        key: transfer.sender.avatarKey,
        updatedAt: transfer.sender.avatarUpdatedAt ?? null,
      }),
    };
    const recipient = {
      userId: transfer.recipient.id,
      username: transfer.recipient.username ?? null,
      displayName: transfer.recipient.name ?? null,
      avatarUrl: publicAssetUrl({
        publicBaseUrl,
        key: transfer.recipient.avatarKey,
        updatedAt: transfer.recipient.avatarUpdatedAt ?? null,
      }),
    };
    const isAdminAddedForRecipient = transfer.kind === 'admin_adjust' && transfer.recipientId === userId;
    const isAdminRemovedForRecipient = transfer.kind === 'admin_adjust' && transfer.senderId === userId;
    const isSender = transfer.senderId === userId;
    const counterparty = isSender ? recipient : sender;
    const direction: CoinTransferReceiptDto['direction'] = isAdminAddedForRecipient
      ? 'admin_added'
      : isAdminRemovedForRecipient
        ? 'admin_removed'
      : (isSender ? 'sent' : 'received');

    return {
      id: transfer.id,
      createdAt: transfer.createdAt.toISOString(),
      amount: transfer.amount,
      note: transfer.note ?? null,
      direction,
      sender,
      recipient,
      counterparty: {
        userId: counterparty.userId,
        username: counterparty.username ?? '',
        displayName: counterparty.displayName,
        avatarUrl: counterparty.avatarUrl,
      },
    };
  }
}
