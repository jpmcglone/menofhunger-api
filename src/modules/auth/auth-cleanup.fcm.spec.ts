import { AuthCleanupCron } from "./auth-cleanup.cron";

describe("Auth cleanup FCM lifecycle", () => {
  it("prunes stale/revoked/expired/banned/deleting bindings with the existing scheduled auth cleanup", async () => {
    const prisma = {
      fcmDeviceRegistration: {
        deleteMany: jest.fn().mockResolvedValue({ count: 2 }),
      },
      session: { deleteMany: jest.fn().mockResolvedValue({ count: 0 }) },
      phoneOtp: { deleteMany: jest.fn().mockResolvedValue({ count: 0 }) },
      $transaction: jest
        .fn()
        .mockImplementation((operations: Promise<unknown>[]) =>
          Promise.all(operations),
        ),
    };
    const service = new AuthCleanupCron(
      prisma as never,
      {} as never,
      {} as never,
    );
    await service.runCleanupExpiredAuthRecords();
    expect(prisma.fcmDeviceRegistration.deleteMany).toHaveBeenCalledWith({
      where: {
        OR: [
          { lastSeenAt: { lt: expect.any(Date) } },
          { session: { revokedAt: { not: null } } },
          { session: { expiresAt: { lte: expect.any(Date) } } },
          { user: { bannedAt: { not: null } } },
          { user: { deletionScheduledAt: { not: null } } },
        ],
      },
    });
    expect(prisma.$transaction).toHaveBeenCalledTimes(1);
  });
});
