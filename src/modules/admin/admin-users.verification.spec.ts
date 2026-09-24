import { AdminUsersController } from './admin-users.controller';

describe('Admin user profile verification', () => {
  it.each(['none', 'manual'] as const)('resolves pending requests and records the admin from %s', async (verifiedStatus) => {
    const verifiedAt = new Date('2026-01-01T00:00:00Z');
    const current = { id: 'u1', username: 'member', verifiedStatus, verifiedAt, premium: false };
    const controller = Object.create(AdminUsersController.prototype) as any;
    controller.prisma = { user: {
      findUnique: jest.fn().mockResolvedValue(current),
      update: jest.fn().mockResolvedValue(current),
    } };
    controller.userVerification = { verifyUser: jest.fn().mockResolvedValue({ verified: true }) };
    controller.entitlementService = { recomputeAndApply: jest.fn() };
    controller.publicProfileCache = { invalidateForUser: jest.fn() };
    controller.usersPublicRealtime = { emitPublicProfileUpdated: jest.fn() };
    controller.usersMeRealtime = { emitMeUpdatedFromUser: jest.fn() };
    controller.toAdminUserDto = jest.fn().mockResolvedValue(current);

    await controller.updateUser('u1', { verifiedStatus: 'identity' }, { user: { id: 'admin1' } });

    expect(controller.userVerification.verifyUser).toHaveBeenCalledWith(expect.objectContaining({
      userId: 'u1', source: 'admin_patch', adminUserId: 'admin1',
    }));
    if (verifiedStatus === 'manual') {
      expect(controller.prisma.user.update).toHaveBeenCalledWith({
        where: { id: 'u1' },
        data: { verifiedStatus: 'identity', verifiedAt, unverifiedAt: null },
      });
    }
  });
});
