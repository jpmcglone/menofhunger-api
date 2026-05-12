import { ForbiddenException, NotFoundException } from '@nestjs/common';
import { CrewService } from './crew.service';

// ─── Fixtures + deps factory ─────────────────────────────────────────────────
//
// CrewService has 4 collaborators. For owner-vs-admin gating on updateCrew we
// only need `prisma`, `appConfig`, and `presenceRealtime` to respond; the rest
// is no-op'd. Tests override specific behaviors where needed.

const FAKE_USER_ROW = {
  id: 'u-owner',
  username: 'owner',
  name: 'Owner',
  premium: false,
  premiumPlus: false,
  isOrganization: false,
  stewardBadgeEnabled: true,
  verifiedStatus: 'verified',
  avatarKey: null,
  avatarUpdatedAt: null,
  bannedAt: null,
  isBot: false,
  orgMemberships: [],
};

const FAKE_CREW = {
  id: 'c1',
  slug: 'crew-1',
  name: 'Crew One',
  tagline: null,
  bio: null,
  avatarImageUrl: null,
  coverImageUrl: null,
  designatedSuccessorUserId: null,
  ownerUserId: 'u-owner',
  wallConversationId: 'conv-1',
  memberCount: 1,
  createdAt: new Date('2025-01-01T00:00:00Z'),
  deletedAt: null,
};

const FAKE_CREW_WITH_RELATIONS = {
  ...FAKE_CREW,
  owner: FAKE_USER_ROW,
  members: [
    {
      crewId: 'c1',
      userId: 'u-owner',
      role: 'owner' as const,
      sortOrder: 0,
      createdAt: new Date('2025-01-01T00:00:00Z'),
      user: FAKE_USER_ROW,
    },
  ],
};

function makeService(prismaOverrides: Record<string, any> = {}) {
  const prisma: any = {
    crew: {
      findUnique: jest.fn(async (args: any) => {
        if (args?.include) return FAKE_CREW_WITH_RELATIONS;
        return { ...FAKE_CREW };
      }),
      // Used by ensureUniqueCrewSlug when a name change triggers slug regen.
      findFirst: jest.fn(async () => null),
      update: jest.fn(),
    },
    crewMember: {
      findUnique: jest.fn(),
    },
    crewSlugHistory: {
      create: jest.fn(),
      findUnique: jest.fn(),
    },
    crewInvite: {
      count: jest.fn(async () => 0),
    },
    user: {
      findUnique: jest.fn(async () => ({ verifiedStatus: 'verified', bannedAt: null })),
    },
    $transaction: jest.fn(async (cb: any) =>
      cb({
        crew: { update: jest.fn() },
        crewSlugHistory: { create: jest.fn() },
      }),
    ),
    ...prismaOverrides,
  };

  const appConfig: any = { r2: jest.fn(() => null) };
  const presenceRealtime: any = { emitCrewUpdated: jest.fn() };
  const notifications: any = {};

  const service = new CrewService(prisma, appConfig, presenceRealtime, notifications);
  return { service, prisma, presenceRealtime };
}

describe('CrewService.updateCrew — owner vs. site admin', () => {
  it('rejects a non-owner non-admin viewer', async () => {
    const { service, prisma } = makeService();
    prisma.crewMember.findUnique.mockResolvedValue({ role: 'member' });

    await expect(
      service.updateCrew({
        viewerUserId: 'member-1',
        isSiteAdmin: false,
        crewId: 'c1',
        name: 'Nope',
      }),
    ).rejects.toThrow(ForbiddenException);
  });

  it('rejects when the viewer is not a member and not an admin', async () => {
    const { service, prisma } = makeService();
    prisma.crewMember.findUnique.mockResolvedValue(null);

    await expect(
      service.updateCrew({
        viewerUserId: 'stranger',
        isSiteAdmin: false,
        crewId: 'c1',
        name: 'Nope',
      }),
    ).rejects.toThrow(ForbiddenException);
  });

  it('throws NotFoundException when the crew does not exist', async () => {
    const { service, prisma } = makeService();
    prisma.crew.findUnique.mockImplementation(async () => null);

    await expect(
      service.updateCrew({
        viewerUserId: 'anyone',
        isSiteAdmin: true,
        crewId: 'gone',
        name: 'Nope',
      }),
    ).rejects.toThrow(NotFoundException);
  });

  it('throws NotFoundException when the crew is soft-deleted', async () => {
    const { service, prisma } = makeService();
    prisma.crew.findUnique.mockImplementation(async () => ({
      ...FAKE_CREW,
      deletedAt: new Date(),
    }));

    await expect(
      service.updateCrew({
        viewerUserId: 'admin-1',
        isSiteAdmin: true,
        crewId: 'c1',
        name: 'Nope',
      }),
    ).rejects.toThrow(NotFoundException);
  });

  it('allows a site admin who is NOT a member to update name, tagline, bio, avatar, banner', async () => {
    const { service, prisma, presenceRealtime } = makeService();
    // Admin is not in the crew.
    prisma.crewMember.findUnique.mockResolvedValue(null);

    await service.updateCrew({
      viewerUserId: 'admin-1',
      isSiteAdmin: true,
      crewId: 'c1',
      name: 'Renamed by admin',
      tagline: 'Tag',
      bio: 'Bio',
      avatarImageUrl: 'https://cdn/a.png',
      coverImageUrl: 'https://cdn/b.png',
    });

    expect(prisma.$transaction).toHaveBeenCalled();
    expect(presenceRealtime.emitCrewUpdated).toHaveBeenCalledWith(
      ['u-owner'],
      expect.objectContaining({ crew: expect.any(Object) }),
    );
  });

  it('skips the verification gate for site admins (so unverified admins can still moderate)', async () => {
    // The default user.findUnique returns verifiedStatus='verified'; for admins
    // we expect the gate not to be consulted at all.
    const { service, prisma } = makeService();
    prisma.crewMember.findUnique.mockResolvedValue(null);

    await service.updateCrew({
      viewerUserId: 'admin-1',
      isSiteAdmin: true,
      crewId: 'c1',
      bio: 'Edited by admin',
    });

    expect(prisma.user.findUnique).not.toHaveBeenCalled();
  });

  it('owners still need to be verified', async () => {
    const { service, prisma } = makeService();
    prisma.crewMember.findUnique.mockResolvedValue({ role: 'owner' });
    // Owner has lapsed verification.
    prisma.user.findUnique.mockResolvedValue({
      verifiedStatus: 'none',
      bannedAt: null,
    });

    await expect(
      service.updateCrew({
        viewerUserId: 'u-owner',
        isSiteAdmin: false,
        crewId: 'c1',
        bio: 'Edit attempt',
      }),
    ).rejects.toThrow(ForbiddenException);
  });

  it('owner edits still succeed for a verified owner', async () => {
    const { service, prisma } = makeService();
    prisma.crewMember.findUnique.mockResolvedValue({ role: 'owner' });

    await service.updateCrew({
      viewerUserId: 'u-owner',
      isSiteAdmin: false,
      crewId: 'c1',
      bio: 'Edit by owner',
    });

    expect(prisma.$transaction).toHaveBeenCalled();
  });

  it('sending avatarImageUrl: null writes null to the row (clears the image)', async () => {
    let capturedData: any = null;
    const { service, prisma } = makeService({
      $transaction: jest.fn(async (cb: any) =>
        cb({
          crew: {
            update: jest.fn(async (args: any) => {
              capturedData = args?.data ?? null;
              return { ...FAKE_CREW };
            }),
          },
          crewSlugHistory: { create: jest.fn() },
        }),
      ),
    });
    prisma.crewMember.findUnique.mockResolvedValue({ role: 'owner' });

    await service.updateCrew({
      viewerUserId: 'u-owner',
      isSiteAdmin: false,
      crewId: 'c1',
      avatarImageUrl: null,
    });

    expect(capturedData).toEqual(expect.objectContaining({ avatarImageUrl: null }));
  });

  it('sending coverImageUrl: null writes null to the row (clears the cover)', async () => {
    let capturedData: any = null;
    const { service, prisma } = makeService({
      $transaction: jest.fn(async (cb: any) =>
        cb({
          crew: {
            update: jest.fn(async (args: any) => {
              capturedData = args?.data ?? null;
              return { ...FAKE_CREW };
            }),
          },
          crewSlugHistory: { create: jest.fn() },
        }),
      ),
    });
    prisma.crewMember.findUnique.mockResolvedValue({ role: 'owner' });

    await service.updateCrew({
      viewerUserId: 'u-owner',
      isSiteAdmin: false,
      crewId: 'c1',
      coverImageUrl: null,
    });

    expect(capturedData).toEqual(expect.objectContaining({ coverImageUrl: null }));
  });

  it('omitting avatarImageUrl/coverImageUrl leaves them untouched', async () => {
    let capturedData: any = null;
    const { service, prisma } = makeService({
      $transaction: jest.fn(async (cb: any) =>
        cb({
          crew: {
            update: jest.fn(async (args: any) => {
              capturedData = args?.data ?? null;
              return { ...FAKE_CREW };
            }),
          },
          crewSlugHistory: { create: jest.fn() },
        }),
      ),
    });
    prisma.crewMember.findUnique.mockResolvedValue({ role: 'owner' });

    await service.updateCrew({
      viewerUserId: 'u-owner',
      isSiteAdmin: false,
      crewId: 'c1',
      bio: 'Only bio is changing',
    });

    expect(capturedData).not.toHaveProperty('avatarImageUrl');
    expect(capturedData).not.toHaveProperty('coverImageUrl');
  });
});

describe('CrewService.updateMyCrew — delegates to updateCrew', () => {
  it('throws NotFoundException when the viewer is not in a crew', async () => {
    const { service, prisma } = makeService();
    prisma.crewMember.findUnique.mockResolvedValue(null);

    await expect(
      service.updateMyCrew({ viewerUserId: 'u-owner', bio: 'x' }),
    ).rejects.toThrow(NotFoundException);
  });

  it('resolves the viewer\'s crew, then forwards to updateCrew (which still enforces owner-only when isSiteAdmin=false)', async () => {
    const { service, prisma } = makeService();
    // First call (in updateMyCrew): user's membership lookup.
    // Second call (in updateCrew): viewer membership for the resolved crewId.
    prisma.crewMember.findUnique
      .mockResolvedValueOnce({ crewId: 'c1', role: 'member' })
      .mockResolvedValueOnce({ role: 'member' });

    await expect(
      service.updateMyCrew({ viewerUserId: 'u-member', bio: 'x' }),
    ).rejects.toThrow(ForbiddenException);
  });
});
