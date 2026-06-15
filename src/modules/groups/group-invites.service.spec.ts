import { ForbiddenException } from '@nestjs/common';
import { GroupInvitesService } from './group-invites.service';

function makeService(prismaOverrides: Record<string, any> = {}) {
  const prisma: any = {
    user: { findUnique: jest.fn(async () => ({ verifiedStatus: 'none' })) },
    communityGroupInvite: { findUnique: jest.fn() },
    communityGroup: { findFirst: jest.fn() },
    communityGroupMember: { findUnique: jest.fn() },
    $transaction: jest.fn(),
    ...prismaOverrides,
  };
  const appConfig: any = { r2: jest.fn(() => null) };
  const presenceRealtime: any = {};
  const notifications: any = {};
  const service = new GroupInvitesService(prisma, appConfig, presenceRealtime, notifications);
  return { service, prisma };
}

describe('GroupInvitesService.acceptInvite — verification gate', () => {
  it('rejects an unverified user before reading the invite', async () => {
    const inviteFindUnique = jest.fn();
    const { service } = makeService({
      user: { findUnique: jest.fn(async () => ({ verifiedStatus: 'none' })) },
      communityGroupInvite: { findUnique: inviteFindUnique },
    });

    await expect(
      service.acceptInvite({ viewerUserId: 'u1', inviteId: 'inv1' }),
    ).rejects.toThrow(ForbiddenException);
    await expect(
      service.acceptInvite({ viewerUserId: 'u1', inviteId: 'inv1' }),
    ).rejects.toThrow(/verify/i);
    expect(inviteFindUnique).not.toHaveBeenCalled();
  });

  it('lets a verified user past the gate (then reads the invite)', async () => {
    const inviteFindUnique = jest.fn(async () => null); // missing invite -> NotFound proves we passed the gate
    const { service } = makeService({
      user: { findUnique: jest.fn(async () => ({ verifiedStatus: 'identity' })) },
      communityGroupInvite: { findUnique: inviteFindUnique },
    });

    await expect(
      service.acceptInvite({ viewerUserId: 'u1', inviteId: 'inv1' }),
    ).rejects.toThrow(/invite not found/i);
    expect(inviteFindUnique).toHaveBeenCalled();
  });
});
