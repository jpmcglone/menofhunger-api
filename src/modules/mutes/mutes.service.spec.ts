import { BadRequestException, NotFoundException } from '@nestjs/common';
import { MutesService } from './mutes.service';

function setup() {
  const prisma = {
    user: { findUnique: jest.fn().mockResolvedValue({ id: 'target' }) },
    userMute: {
      findMany: jest.fn().mockResolvedValue([{ mutedId: 'target' }]),
      upsert: jest.fn().mockResolvedValue({}),
      deleteMany: jest.fn().mockResolvedValue({ count: 1 }),
    },
  };
  const redis = {
    getJson: jest.fn().mockResolvedValue(null),
    setJson: jest.fn().mockResolvedValue(undefined),
    del: jest.fn().mockResolvedValue(1),
  };
  return { service: new MutesService(prisma as any, redis as any), prisma, redis };
}

describe('MutesService', () => {
  it('reads the muted set from the database and caches it', async () => {
    const { service, redis } = setup();
    expect(await service.hasMuted('me', 'target')).toBe(true);
    expect(await service.hasMuted('me', 'someone-else')).toBe(false);
    expect(redis.setJson).toHaveBeenCalledWith('viewer:mutes:me', ['target'], { ttlSeconds: 300 });
  });

  it('never treats yourself or a missing actor as muted, and returns nothing for signed-out viewers', async () => {
    const { service, prisma } = setup();
    expect(await service.hasMuted('me', 'me')).toBe(false);
    expect(await service.hasMuted('me', null)).toBe(false);
    expect(await service.mutedIds(null)).toEqual(new Set());
    expect(prisma.userMute.findMany).not.toHaveBeenCalled();
  });

  it('mutes and unmutes idempotently, busting the cache', async () => {
    const { service, prisma, redis } = setup();
    await service.mute('me', 'target');
    expect(prisma.userMute.upsert).toHaveBeenCalledWith({
      where: { muterId_mutedId: { muterId: 'me', mutedId: 'target' } },
      create: { muterId: 'me', mutedId: 'target' },
      update: {},
    });
    await service.unmute('me', 'target');
    expect(prisma.userMute.deleteMany).toHaveBeenCalledWith({ where: { muterId: 'me', mutedId: 'target' } });
    expect(redis.del).toHaveBeenCalledTimes(2);
  });

  it('rejects muting yourself or an unknown user', async () => {
    const { service, prisma } = setup();
    await expect(service.mute('me', 'me')).rejects.toBeInstanceOf(BadRequestException);
    prisma.user.findUnique.mockResolvedValue(null);
    await expect(service.mute('me', 'ghost')).rejects.toBeInstanceOf(NotFoundException);
  });
});
