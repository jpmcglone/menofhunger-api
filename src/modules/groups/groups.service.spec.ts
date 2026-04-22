import { BadRequestException, ForbiddenException, NotFoundException } from '@nestjs/common';
import { GroupsService } from './groups.service';

// ─── Deps factory ────────────────────────────────────────────────────────────
//
// GroupsService has 5 collaborators. For the privacy-transition tests below we
// only need `prisma` to respond; the rest are no-op'd. Tests that need deeper
// behavior can override specific fields.

const FAKE_GROUP = {
  id: 'g1',
  slug: 'g',
  name: 'G',
  description: 'desc',
  rules: null,
  coverImageUrl: null,
  avatarImageUrl: null,
  joinPolicy: 'approval' as const,
  memberCount: 1,
  isFeatured: false,
  featuredOrder: null,
  createdAt: new Date('2025-01-01T00:00:00Z'),
  deletedAt: null,
};

function makeService(prismaOverrides: Record<string, any> = {}) {
  const prisma: any = {
    communityGroup: {
      findFirst: jest.fn(),
      update: jest.fn(async (args: any) => ({ ...FAKE_GROUP, ...args.data })),
    },
    communityGroupMember: {
      findUnique: jest.fn(),
    },
    ...prismaOverrides,
  };

  const posts: any = {};
  const appConfig: any = { r2: jest.fn(() => null) };
  const notifications: any = {};
  const redis: any = {};

  const service = new GroupsService(prisma, posts, appConfig, notifications, redis);
  return { service, prisma };
}

describe('GroupsService.updateGroup — privacy transitions', () => {
  it('blocks private -> open transition with a BadRequestException', async () => {
    const { service, prisma } = makeService();
    prisma.communityGroup.findFirst.mockResolvedValue({
      id: 'g1',
      joinPolicy: 'approval',
      deletedAt: null,
    });
    // First member lookup: owner permission check.
    prisma.communityGroupMember.findUnique.mockResolvedValue({
      role: 'owner',
      status: 'active',
    });

    await expect(
      service.updateGroup({
        viewerUserId: 'owner',
        isSiteAdmin: false,
        groupId: 'g1',
        joinPolicy: 'open',
      }),
    ).rejects.toThrow(BadRequestException);

    expect(prisma.communityGroup.update).not.toHaveBeenCalled();
  });

  it('allows open -> private transition (one-way)', async () => {
    const { service, prisma } = makeService();
    prisma.communityGroup.findFirst.mockResolvedValue({
      id: 'g1',
      joinPolicy: 'open',
      deletedAt: null,
    });
    prisma.communityGroupMember.findUnique.mockResolvedValue({
      role: 'owner',
      status: 'active',
    });

    await service.updateGroup({
      viewerUserId: 'owner',
      isSiteAdmin: false,
      groupId: 'g1',
      joinPolicy: 'approval',
    });

    expect(prisma.communityGroup.update).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: 'g1' },
        data: expect.objectContaining({ joinPolicy: 'approval' }),
      }),
    );
  });

  it('rejects updates from non-owner non-admin viewers', async () => {
    const { service, prisma } = makeService();
    prisma.communityGroup.findFirst.mockResolvedValue({
      id: 'g1',
      joinPolicy: 'open',
      deletedAt: null,
    });
    prisma.communityGroupMember.findUnique.mockResolvedValue({
      role: 'member',
      status: 'active',
    });

    await expect(
      service.updateGroup({
        viewerUserId: 'member',
        isSiteAdmin: false,
        groupId: 'g1',
        joinPolicy: 'approval',
      }),
    ).rejects.toThrow(ForbiddenException);
  });

  it('throws NotFoundException when the group does not exist or is deleted', async () => {
    const { service, prisma } = makeService();
    prisma.communityGroup.findFirst.mockResolvedValue(null);
    await expect(
      service.updateGroup({
        viewerUserId: 'owner',
        isSiteAdmin: false,
        groupId: 'gone',
        joinPolicy: 'approval',
      }),
    ).rejects.toThrow(NotFoundException);
  });

  it('site admin still cannot bypass the private -> open block', async () => {
    const { service, prisma } = makeService();
    prisma.communityGroup.findFirst.mockResolvedValue({
      id: 'g1',
      joinPolicy: 'approval',
      deletedAt: null,
    });
    prisma.communityGroupMember.findUnique.mockResolvedValue(null);

    await expect(
      service.updateGroup({
        viewerUserId: 'admin',
        isSiteAdmin: true,
        groupId: 'g1',
        joinPolicy: 'open',
      }),
    ).rejects.toThrow(BadRequestException);
  });
});
