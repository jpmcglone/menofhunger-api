import { ConflictException } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { CrewInvitesService } from './crew-invites.service';

type AnyPrisma = any;

function makeInviteRow(overrides: Partial<any> = {}) {
  const now = new Date('2026-01-01T00:00:00.000Z');
  return {
    id: 'inv1',
    createdAt: now,
    expiresAt: new Date('2026-01-08T00:00:00.000Z'),
    respondedAt: null,
    status: 'pending',
    message: null,
    crewId: 'targetCrew',
    crewNameOnAccept: null,
    invitedByUserId: 'inviter',
    inviteeUserId: 'viewer',
    crew: null,
    invitedBy: {
      id: 'inviter',
      username: 'inviter',
      name: 'Inviter',
      avatarKey: null,
      avatarUpdatedAt: null,
      premium: false,
      isOrganization: false,
      verifiedStatus: 'identity',
      bannedAt: null,
    },
    invitee: {
      id: 'viewer',
      username: 'viewer',
      name: 'Viewer',
      avatarKey: null,
      avatarUpdatedAt: null,
      premium: false,
      isOrganization: false,
      verifiedStatus: 'identity',
      bannedAt: null,
    },
    ...overrides,
  };
}

function makeService(prismaOverrides?: Partial<AnyPrisma>) {
  const txCalls: any[] = [];
  const prisma: AnyPrisma = {
    crewMember: {
      findUnique: jest.fn(),
      create: jest.fn(),
      delete: jest.fn(),
      deleteMany: jest.fn(),
      findMany: jest.fn(async () => []),
    },
    crew: {
      findUnique: jest.fn(),
      create: jest.fn(),
      update: jest.fn(),
    },
    crewInvite: {
      findUnique: jest.fn(),
      findUniqueOrThrow: jest.fn(async () => makeInviteRow({ status: 'accepted' })),
      create: jest.fn(async () => makeInviteRow()),
      update: jest.fn(),
      updateMany: jest.fn(),
      findFirst: jest.fn(async () => null),
      count: jest.fn(async () => 0),
      findMany: jest.fn(async () => []),
    },
    user: {
      findUnique: jest.fn(async () => ({
        id: 'invitee',
        verifiedStatus: 'identity',
        bannedAt: null,
      })),
    },
    messageConversation: { create: jest.fn() },
    messageParticipant: { create: jest.fn(), createMany: jest.fn(), deleteMany: jest.fn() },
    $transaction: jest.fn(async (cbOrArr: any) => {
      txCalls.push(cbOrArr);
      if (typeof cbOrArr === 'function') return cbOrArr(prisma);
      return Promise.all(cbOrArr);
    }),
    ...prismaOverrides,
  };

  const appConfig = { r2: jest.fn(() => null) } as any;
  const presenceRealtime = {
    emitCrewInviteReceived: jest.fn(),
    emitCrewInviteUpdated: jest.fn(),
    emitCrewMembersChanged: jest.fn(),
    emitCrewDisbanded: jest.fn(),
  } as any;
  const notifications = {
    create: jest.fn(async () => undefined),
    markCrewInviteResolved: jest.fn(async () => undefined),
  } as any;
  const crew = {
    assertVerified: jest.fn(async () => undefined),
    disbandCrewTx: jest.fn(async () => undefined),
  } as any;

  const svc = new CrewInvitesService(
    prisma,
    appConfig,
    presenceRealtime,
    notifications,
    crew,
  );

  return { svc, prisma, presenceRealtime, notifications, crew };
}

describe('CrewInvitesService.sendInvite — solo eligibility', () => {
  it('allows inviting a user whose crew has memberCount 1 (solo)', async () => {
    const { svc, prisma } = makeService();
    // Inviter has no crew (founding invite scenario).
    (prisma.crewMember.findUnique as jest.Mock).mockImplementation(({ where }) => {
      if (where.userId === 'invitee') {
        return Promise.resolve({
          crewId: 'soloCrew',
          role: 'owner',
          crew: { memberCount: 1 },
        });
      }
      return Promise.resolve(null);
    });
    (prisma.crewInvite.create as jest.Mock).mockResolvedValue(
      makeInviteRow({ inviteeUserId: 'invitee', crewId: null }),
    );

    await expect(
      svc.sendInvite({ viewerUserId: 'inviter', inviteeUserId: 'invitee' }),
    ).resolves.toBeDefined();
    expect(prisma.crewInvite.create).toHaveBeenCalled();
  });

  it('blocks inviting a user whose crew has memberCount > 1', async () => {
    const { svc, prisma } = makeService();
    (prisma.crewMember.findUnique as jest.Mock).mockImplementation(({ where }) => {
      if (where.userId === 'invitee') {
        return Promise.resolve({
          crewId: 'multiCrew',
          role: 'member',
          crew: { memberCount: 3 },
        });
      }
      return Promise.resolve(null);
    });

    await expect(
      svc.sendInvite({ viewerUserId: 'inviter', inviteeUserId: 'invitee' }),
    ).rejects.toBeInstanceOf(ConflictException);
    expect(prisma.crewInvite.create).not.toHaveBeenCalled();
  });
});

describe('CrewInvitesService.acceptInvite — solo auto-disband', () => {
  function pendingInvite(overrides: Partial<any> = {}) {
    return {
      id: 'inv1',
      status: 'pending',
      invitedByUserId: 'inviter',
      inviteeUserId: 'viewer',
      crewId: 'targetCrew',
      expiresAt: new Date(Date.now() + 60_000),
      ...overrides,
    };
  }

  it('joins target crew + auto-disbands viewer\'s solo crew (existing-crew path)', async () => {
    const { svc, prisma, crew, presenceRealtime } = makeService();

    (prisma.crewInvite.findUnique as jest.Mock).mockResolvedValue(pendingInvite());
    // Two reads of CrewMember for the viewer:
    //   1) findBlockingMembership -> solo (memberCount 1) returns null (not blocking).
    //   2) findSoloCrewIdToDisband -> returns the solo crew id.
    (prisma.crewMember.findUnique as jest.Mock).mockImplementation(({ where }) => {
      if (where.userId !== 'viewer') return Promise.resolve(null);
      // Both reads share the same shape; both branches return the same data.
      return Promise.resolve({
        crewId: 'soloCrew',
        role: 'owner',
        crew: { memberCount: 1, deletedAt: null },
      });
    });
    (prisma.crew.findUnique as jest.Mock).mockResolvedValue({
      id: 'targetCrew',
      deletedAt: null,
      memberCount: 2,
      wallConversationId: 'wallTarget',
      ownerUserId: 'inviter',
    });

    const res = await svc.acceptInvite({ viewerUserId: 'viewer', inviteId: 'inv1' });

    expect(res).toEqual({ crewId: 'targetCrew' });
    // Race-safe guarded update is applied to the solo crew.
    expect(prisma.crew.update).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: 'soloCrew', memberCount: 1 },
        data: expect.objectContaining({ deletedAt: expect.any(Date) }),
      }),
    );
    // disbandCrewTx is invoked inside the same transaction.
    expect(crew.disbandCrewTx).toHaveBeenCalledWith(prisma, 'soloCrew');
    // Viewer is added to the target crew.
    expect(prisma.crewMember.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: { crewId: 'targetCrew', userId: 'viewer', role: 'member' },
      }),
    );
    // Disband event is emitted to just the viewer.
    expect(presenceRealtime.emitCrewDisbanded).toHaveBeenCalledWith(['viewer'], {
      crewId: 'soloCrew',
    });
  });

  it('does NOT call disbandCrewTx when viewer has no crew', async () => {
    const { svc, prisma, crew, presenceRealtime } = makeService();

    (prisma.crewInvite.findUnique as jest.Mock).mockResolvedValue(pendingInvite());
    (prisma.crewMember.findUnique as jest.Mock).mockResolvedValue(null);
    (prisma.crew.findUnique as jest.Mock).mockResolvedValue({
      id: 'targetCrew',
      deletedAt: null,
      memberCount: 2,
      wallConversationId: 'wallTarget',
      ownerUserId: 'inviter',
    });

    await svc.acceptInvite({ viewerUserId: 'viewer', inviteId: 'inv1' });

    expect(crew.disbandCrewTx).not.toHaveBeenCalled();
    expect(presenceRealtime.emitCrewDisbanded).not.toHaveBeenCalled();
  });

  it('blocks when viewer is in a multi-member crew', async () => {
    const { svc, prisma, crew } = makeService();

    (prisma.crewInvite.findUnique as jest.Mock).mockResolvedValue(pendingInvite());
    (prisma.crewMember.findUnique as jest.Mock).mockResolvedValue({
      crewId: 'multiCrew',
      role: 'member',
      crew: { memberCount: 4, deletedAt: null },
    });

    await expect(
      svc.acceptInvite({ viewerUserId: 'viewer', inviteId: 'inv1' }),
    ).rejects.toBeInstanceOf(ConflictException);

    expect(crew.disbandCrewTx).not.toHaveBeenCalled();
    expect(prisma.crewMember.create).not.toHaveBeenCalled();
  });

  it('rolls the whole accept back when the guarded disband update misses (P2025)', async () => {
    const { svc, prisma, crew } = makeService();

    (prisma.crewInvite.findUnique as jest.Mock).mockResolvedValue(pendingInvite());
    (prisma.crewMember.findUnique as jest.Mock).mockResolvedValue({
      crewId: 'soloCrew',
      role: 'owner',
      crew: { memberCount: 1, deletedAt: null },
    });
    (prisma.crew.findUnique as jest.Mock).mockResolvedValue({
      id: 'targetCrew',
      deletedAt: null,
      memberCount: 2,
      wallConversationId: 'wallTarget',
      ownerUserId: 'inviter',
    });
    // Simulate the race: by the time the guarded update runs, the solo crew
    // already has a second member, so the update finds nothing.
    (prisma.crew.update as jest.Mock).mockImplementationOnce(() => {
      throw new Prisma.PrismaClientKnownRequestError('Record not found.', {
        code: 'P2025',
        clientVersion: 'test',
      } as any);
    });

    await expect(
      svc.acceptInvite({ viewerUserId: 'viewer', inviteId: 'inv1' }),
    ).rejects.toBeInstanceOf(ConflictException);

    // Auto-disband bailed before the join writes happened.
    expect(crew.disbandCrewTx).not.toHaveBeenCalled();
    expect(prisma.crewMember.create).not.toHaveBeenCalled();
  });
});
