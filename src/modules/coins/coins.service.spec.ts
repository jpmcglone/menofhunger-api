import { BadRequestException } from '@nestjs/common';
import { CoinsService } from './coins.service';

function makeService(overrides?: { prisma?: any }) {
  const prisma =
    overrides?.prisma ??
    ({
      user: {
        findUnique: jest.fn(async () => ({ id: 'sender-1', verifiedStatus: 'identity' })),
        findFirst: jest.fn(async () => ({
          id: 'recipient-1',
          username: 'john',
          name: 'John',
          avatarKey: null,
          avatarUpdatedAt: null,
          bannedAt: null,
          verifiedStatus: 'identity',
        })),
      },
      $transaction: jest.fn(async (fn: any) =>
        fn({
          user: {
            findUnique: jest.fn(async () => ({ id: 'sender-1', coins: 100 })),
            update: jest.fn(async () => ({ coins: 99 })),
          },
          coinTransfer: { create: jest.fn(async () => ({ id: 'transfer-1' })) },
        }),
      ),
      coinTransfer: { findMany: jest.fn(async () => []) },
    } as any);

  const appConfig = { r2: jest.fn(() => null) } as any;
  const notifications = { create: jest.fn(async () => undefined) } as any;
  const usersMeRealtime = { emitMeUpdated: jest.fn(async () => undefined) } as any;
  const svc = new CoinsService(prisma, appConfig, notifications, usersMeRealtime);
  return { svc, prisma };
}

describe('CoinsService access rules', () => {
  it('blocks unverified senders from using coin transfer', async () => {
    const { svc } = makeService({
      prisma: {
        user: {
          findUnique: jest.fn(async () => ({ id: 'sender-1', verifiedStatus: 'none' })),
          findFirst: jest.fn(),
        },
        $transaction: jest.fn(),
        coinTransfer: { findMany: jest.fn() },
      },
    });

    await expect(
      svc.transfer({
        senderUserId: 'sender-1',
        recipientUsername: 'john',
        amount: 1,
        note: null,
      }),
    ).rejects.toThrow(BadRequestException);
  });

  it('blocks sending coins to unverified recipients', async () => {
    const { svc } = makeService({
      prisma: {
        user: {
          findUnique: jest.fn(async () => ({ id: 'sender-1', verifiedStatus: 'identity' })),
          findFirst: jest.fn(async () => ({
            id: 'recipient-1',
            username: 'john',
            name: 'John',
            avatarKey: null,
            avatarUpdatedAt: null,
            bannedAt: null,
            verifiedStatus: 'none',
          })),
        },
        $transaction: jest.fn(),
        coinTransfer: { findMany: jest.fn() },
      },
    });

    await expect(
      svc.transfer({
        senderUserId: 'sender-1',
        recipientUsername: 'john',
        amount: 2,
        note: null,
      }),
    ).rejects.toThrow(BadRequestException);
  });

  it('blocks unverified users from loading transfer history', async () => {
    const { svc } = makeService({
      prisma: {
        user: {
          findUnique: jest.fn(async () => ({ id: 'sender-1', verifiedStatus: 'none' })),
          findFirst: jest.fn(),
        },
        coinTransfer: { findMany: jest.fn() },
        $transaction: jest.fn(),
      },
    });

    await expect(
      svc.listTransfers({
        userId: 'sender-1',
        cursor: null,
        limit: 20,
      }),
    ).rejects.toThrow(BadRequestException);
  });

  it('admin adjustment adds coins and creates admin_adjust transfer', async () => {
    const txUserUpdate = jest.fn(async () => ({ coins: 125 }));
    const txCreate = jest.fn(async () => ({ id: 'transfer-admin-add' }));
    const { svc } = makeService({
      prisma: {
        user: {
          findUnique: jest
            .fn()
            .mockResolvedValueOnce({ id: 'admin-1', username: 'boss', name: 'Boss' })
            .mockResolvedValueOnce({ id: 'user-1', username: 'target', name: 'Target', coins: 100 }),
        },
        $transaction: jest.fn(async (fn: any) =>
          fn({
            user: { update: txUserUpdate },
            coinTransfer: { create: txCreate },
          }),
        ),
      },
    });

    const result = await svc.adminAdjustCoins({
      adminUserId: 'admin-1',
      targetUserId: 'user-1',
      delta: 25,
      reason: 'Promo credit',
    });

    expect(result.delta).toBe(25);
    expect(result.targetBalanceAfter).toBe(125);
    expect(txUserUpdate).toHaveBeenCalledWith(
      expect.objectContaining({ data: { coins: { increment: 25 } } }),
    );
    expect(txCreate).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          kind: 'admin_adjust',
          senderId: 'admin-1',
          recipientId: 'user-1',
          amount: 25,
        }),
      }),
    );
  });

  it('admin adjustment blocks removals greater than current balance', async () => {
    const { svc } = makeService({
      prisma: {
        user: {
          findUnique: jest
            .fn()
            .mockResolvedValueOnce({ id: 'admin-1', username: 'boss', name: 'Boss' })
            .mockResolvedValueOnce({ id: 'user-1', username: 'target', name: 'Target', coins: 3 }),
        },
        $transaction: jest.fn(async (fn: any) =>
          fn({
            user: { update: jest.fn() },
            coinTransfer: { create: jest.fn() },
          }),
        ),
      },
    });

    await expect(
      svc.adminAdjustCoins({
        adminUserId: 'admin-1',
        targetUserId: 'user-1',
        delta: -5,
      }),
    ).rejects.toThrow(BadRequestException);
  });
});

