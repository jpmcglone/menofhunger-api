import { ForbiddenException } from '@nestjs/common';
import { UsersMeService } from './users-me.service';

jest.mock('./user.dto', () => ({ toUserDto: (u: unknown) => u }));

function makeService(opts: { setLegacyFields?: jest.Mock } = {}) {
  const prisma: any = {
    user: { findUnique: jest.fn(async () => ({ email: null, username: 'alice', name: 'Alice' })) },
  };
  const profileWrite: any = { commit: jest.fn(async () => ({ id: 'u1', username: 'alice' })) };
  const profileLinks: any = { setLegacyFields: opts.setLegacyFields ?? jest.fn(async () => undefined) };
  const appConfig: any = { r2: () => null };
  const noop: any = {};
  const presence: any = { markSeenFromHttp: jest.fn() };
  const membersMap: any = { notifyChange: jest.fn() };
  const service = new UsersMeService(
    prisma,
    appConfig,
    noop,
    noop,
    noop,
    noop,
    noop,
    noop,
    noop,
    noop,
    presence,
    noop,
    profileWrite,
    membersMap,
    noop,
    profileLinks,
  );
  return { service, profileWrite, profileLinks };
}

describe('UsersMeService.updateMyProfile link shim', () => {
  it('routes legacy link fields through the links service and keeps them out of the user update', async () => {
    const { service, profileWrite, profileLinks } = makeService();
    await service.updateMyProfile(
      { website: 'example.com', youtubeUrl: 'https://www.youtube.com/@me', rumbleUrl: '', bio: 'hi' },
      'u1',
    );
    expect(profileLinks.setLegacyFields).toHaveBeenCalledWith(
      'u1',
      { website: 'https://example.com/', youtube: 'https://youtube.com/@me', rumble: null },
      { emit: false },
    );
    const update = profileWrite.commit.mock.calls[0][1];
    expect(update).toMatchObject({ bio: 'hi' });
    for (const key of ['website', 'youtubeUrl', 'rumbleUrl', 'linkedinUrl']) expect(update).not.toHaveProperty(key);
  });

  it('propagates the verified-member gate and does not commit the profile', async () => {
    const { service, profileWrite } = makeService({
      setLegacyFields: jest.fn(async () => {
        throw new ForbiddenException('Custom links are for verified members.');
      }),
    });
    await expect(service.updateMyProfile({ website: 'example.com' }, 'u1')).rejects.toBeInstanceOf(ForbiddenException);
    expect(profileWrite.commit).not.toHaveBeenCalled();
  });
});
