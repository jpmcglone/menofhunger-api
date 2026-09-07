import { AvatarVideoService } from './avatar-video.service';
import { avatarCropPixels, avatarVideoSelectionSchema } from './avatar-video-policy';
import { toAvatarVideoDto } from '../../common/dto/avatar-video.dto';

describe('video avatar entitlement', () => {
  const setup = (target: object | null, operator?: object | null, membership: object | null = {}) => {
    const prisma = {
      user: { findUnique: jest.fn().mockResolvedValueOnce(target).mockResolvedValue(operator) },
      userPageOperator: { findFirst: jest.fn().mockResolvedValue(membership) },
    };
    const service = new AvatarVideoService(prisma as never, {} as never, {} as never, {} as never, {} as never, {} as never, {} as never);
    return { service, prisma };
  };
  it.each([{ premium: true }, { premiumPlus: true }])('allows either paid tier: %j', async tier => {
    expect(await setup(tier).service.canSet('person')).toBe(true);
  });
  it('rejects free, missing, and banned accounts', async () => {
    for (const target of [{}, null, { premium: true, bannedAt: new Date() }]) {
      expect(await setup(target).service.canSet('person')).toBe(false);
    }
  });
  it.each([{ premium: true }, { premiumPlus: true }])('allows a paid operator of a free page: %j', async tier => {
    const { service, prisma } = setup({}, tier);
    expect(await service.canSet('page', 'operator')).toBe(true);
    expect(prisma.userPageOperator.findFirst).toHaveBeenCalledWith({ where: { pageUserId: 'page', operatorUserId: 'operator' } });
  });
  it('rejects unrelated paid users and revoked page membership', async () => {
    expect(await setup({}, { premium: true }, null).service.canSet('page', 'stranger')).toBe(false);
  });
  it('rejects free or banned operators of a free page', async () => {
    expect(await setup({}, {}).service.canSet('page', 'operator')).toBe(false);
    expect(await setup({}, { premium: true, bannedAt: new Date() }).service.canSet('page', 'operator')).toBe(false);
  });
  it('authorizes before creating an upload or queueing a commit', async () => {
    await expect(setup({}).service.init('free', null, 'video/mp4')).rejects.toThrow('Premium');
    await expect(setup({}).service.commit('free', null, 'upload', {} as never)).rejects.toThrow('Premium');
  });
});

describe('video avatar contract and crop', () => {
  const selection = { startSeconds: 2, durationSeconds: 5, crop: { x: 0.25, y: 0, width: 0.5, height: 1 } };
  it('maps a normalized landscape selection to square source pixels', () => {
    expect(avatarCropPixels(avatarVideoSelectionSchema.parse(selection), 640, 320)).toEqual({ x: 160, y: 0, size: 320 });
  });
  it('rejects overlong, nonfinite, out-of-bounds, and nonsquare crops', () => {
    expect(avatarVideoSelectionSchema.safeParse({ ...selection, durationSeconds: 5.01 }).success).toBe(false);
    expect(avatarVideoSelectionSchema.safeParse({ ...selection, startSeconds: Infinity }).success).toBe(false);
    expect(avatarVideoSelectionSchema.safeParse({ ...selection, crop: { ...selection.crop, x: 0.75 } }).success).toBe(false);
    expect(() => avatarCropPixels(selection, 320, 320)).toThrow('square');
  });
  it('uses a stable versioned MP4 URL and clears metadata for photo avatars', () => {
    expect(toAvatarVideoDto({ avatarVideoKey: 'avatars/user/version/avatar.mp4', avatarVideoDurationMs: 5000 }, 'https://cdn.test')).toEqual({
      id: 'avatars/user/version/avatar.mp4', url: 'https://cdn.test/avatars/user/version/avatar.mp4', durationMs: 5000, width: 320, height: 320,
    });
    expect(toAvatarVideoDto({ avatarVideoKey: null }, 'https://cdn.test')).toBeNull();
  });
});

describe('avatar publication races', () => {
  function setup(row: object, revision = 2) {
    const prisma = {
      avatarVideoUpload: {
        findUnique: jest.fn().mockResolvedValue(row), findFirst: jest.fn().mockResolvedValue(row),
        update: jest.fn(), updateMany: jest.fn().mockResolvedValue({ count: 1 }),
      },
      user: {
        findUnique: jest.fn().mockResolvedValue({ avatarRevision: revision }),
        updateMany: jest.fn().mockResolvedValue({ count: 1 }),
      },
      $transaction: jest.fn(),
    };
    prisma.$transaction.mockImplementation(async action => action(prisma));
    const transcode = jest.fn();
    const service = new AvatarVideoService(prisma as never, {} as never, {} as never, { transcode } as never, {} as never, {} as never, {} as never);
    return { service, prisma, transcode };
  }
  it('never processes an older upload after a newer avatar edit', async () => {
    const { service, prisma, transcode } = setup({ id: 'old', userId: 'person', status: 'queued', revision: 1 });
    await service.process('old');
    expect(prisma.avatarVideoUpload.update).toHaveBeenCalledWith({ where: { id: 'old' }, data: { status: 'superseded' } });
    expect(transcode).not.toHaveBeenCalled();
    expect(prisma.user.updateMany).not.toHaveBeenCalled();
  });
  it.each(['cancelled', 'ready', 'superseded', 'failed'])('does not revive a %s job', async status => {
    const { service, prisma, transcode } = setup({ id: 'old', status });
    await service.process('old');
    expect(prisma.user.findUnique).not.toHaveBeenCalled();
    expect(transcode).not.toHaveBeenCalled();
  });
  it('cancels only an unfinished job and invalidates its matching revision', async () => {
    const { service, prisma } = setup({ id: 'job', userId: 'person', status: 'queued', revision: 2 });
    await service.cancel('person', 'job');
    expect(prisma.user.updateMany).toHaveBeenCalledWith({ where: { id: 'person', avatarRevision: 2 }, data: { avatarRevision: { increment: 1 } } });
  });
  it('does not invalidate an avatar when publication wins the cancellation race', async () => {
    const { service, prisma } = setup({ id: 'job', userId: 'person', status: 'processing', revision: 2 });
    prisma.avatarVideoUpload.updateMany.mockResolvedValue({ count: 0 });
    await service.cancel('person', 'job');
    expect(prisma.user.updateMany).not.toHaveBeenCalled();
  });
});
