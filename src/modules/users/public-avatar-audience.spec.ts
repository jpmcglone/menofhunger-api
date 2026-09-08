import { UsersController } from './users.controller';

describe('public video avatar viewing', () => {
  it.each([undefined, 'unverified', 'verified'])('includes the avatar MP4 and profile poster for %s viewers', async viewer => {
    const avatarVideo = { id: 'clip', url: 'https://cdn.test/clip.mp4', durationMs: 7000, width: 320, height: 320 };
    const controller = Object.assign(Object.create(UsersController.prototype), {
      prisma: { user: { findUnique: jest.fn(async () => ({ verifiedStatus: viewer === 'verified' ? 'identity' : 'none' })) },
        crewMember: { findFirst: jest.fn(async () => null) }, post: { count: jest.fn(async () => 0) }, article: { count: jest.fn(async () => 0) } },
      appConfig: { isProd: () => true }, posthog: { capture: jest.fn() },
      publicProfiles: { getByUsernameOrId: jest.fn(async () => ({ payload: { id: 'owner', avatarUrl: 'https://cdn.test/poster.jpg', avatarVideo } })),
        batchOrgAffiliations: jest.fn(async () => new Map()) },
    }) as UsersController;
    const result = await controller.publicProfile(viewer, 'owner', { setHeader: jest.fn() } as never);
    expect(result.data).toMatchObject({ avatarUrl: 'https://cdn.test/poster.jpg', avatarVideo });
  });
});
