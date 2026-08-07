import { UsersController } from './users.controller';

describe('UsersController.byLocation', () => {
  it('returns the full eligible state member count independently of the section limit', async () => {
    const prisma = {
      user: {
        findMany: jest.fn(async () => []),
        count: jest.fn(async () => 87),
      },
    };
    const followsService = {
      batchRelationshipForUserIds: jest.fn(async () => ({
        viewerFollows: new Set<string>(),
        followsViewer: new Set<string>(),
        viewerBellEnabled: new Set<string>(),
      })),
    };
    const controller = new UsersController(
      prisma as any,
      { r2: jest.fn(() => null) } as any,
      followsService as any,
      {} as any,
      {} as any,
      {} as any,
      {} as any,
      {} as any,
      {} as any,
      {} as any,
      {} as any,
      {} as any,
      {} as any,
    );

    const result = await controller.byLocation('viewer', { state: 'va', limit: 12 });

    expect(prisma.user.count).toHaveBeenCalledWith({
      where: {
        usernameIsSet: true,
        bannedAt: null,
        locationState: 'VA',
      },
    });
    expect(result.data.location).toMatchObject({ state: 'VA', stateDisplay: 'Virginia' });
    expect(result.data.memberCount).toBe(87);
    expect(result.data.sections[0]?.users).toHaveLength(0);
  });
});
