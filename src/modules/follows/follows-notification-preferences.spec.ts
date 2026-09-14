import { BadRequestException, NotFoundException } from '@nestjs/common';
import { FollowsService } from './follows.service';
import { FollowsController } from './follows.controller';
import { ZodError } from 'zod';

describe('per-user notification preferences', () => {
  function setup() {
    const prisma = {
      user: { findFirst: jest.fn(async () => ({ id: 'author', username: 'author' })) },
      follow: { updateMany: jest.fn(async () => ({ count: 1 })) },
    };
    const realtime = { emitFollowsChanged: jest.fn() };
    const service = new FollowsService(prisma as never, {} as never, {} as never,
      {} as never, {} as never, realtime as never, {} as never, {} as never);
    return { service, prisma, realtime };
  }
  it.each(['all', 'posts', 'off'] as const)('persists %s and emits only to the acting viewer', async preference => {
    const { service, prisma, realtime } = setup();
    expect(await service.setPostNotificationsEnabled({ viewerUserId: 'viewer', username: 'author', preference }))
      .toEqual({ preference, enabled: preference === 'all' });
    expect(prisma.follow.updateMany).toHaveBeenCalledWith({
      where: { followerId: 'viewer', followingId: 'author' },
      data: { notificationPreference: preference, postNotificationsEnabled: preference === 'all' },
    });
    expect(realtime.emitFollowsChanged).toHaveBeenCalledWith('viewer', {
      actorUserId: 'viewer', targetUserId: 'author', viewerFollowsUser: true, viewerNotificationPreference: preference,
    });
  });
  it('keeps legacy false as posts-only, not off', async () => {
    const { service } = setup();
    expect(await service.setPostNotificationsEnabled({ viewerUserId: 'viewer', username: 'author', enabled: false }))
      .toEqual({ enabled: false, preference: 'posts' });
  });
  it('requires an existing follow and never emits on failure', async () => {
    const { service, prisma, realtime } = setup();
    prisma.follow.updateMany.mockResolvedValue({ count: 0 });
    await expect(service.setPostNotificationsEnabled({ viewerUserId: 'viewer', username: 'author', preference: 'off' }))
      .rejects.toBeInstanceOf(NotFoundException);
    expect(realtime.emitFollowsChanged).not.toHaveBeenCalled();
  });
  it('rejects changing your own notifications', async () => {
    const { service, prisma } = setup();
    await expect(service.setPostNotificationsEnabled({ viewerUserId: 'author', username: 'author', preference: 'off' }))
      .rejects.toBeInstanceOf(BadRequestException);
    expect(prisma.follow.updateMany).not.toHaveBeenCalled();
  });
});

describe('author preference request contract', () => {
  it.each([{}, { preference: 'bad' }, { preference: 'off', enabled: true }, { enabled: 'false' }])('rejects invalid body %j before writing', async body => {
    const service = { setPostNotificationsEnabled: jest.fn() };
    const controller = new FollowsController(service as never);
    await expect(controller.setPostNotifications('author', 'viewer', body)).rejects.toBeInstanceOf(ZodError);
    expect(service.setPostNotificationsEnabled).not.toHaveBeenCalled();
  });
  it('accepts the new Off value with the authenticated viewer', async () => {
    const service = { setPostNotificationsEnabled: jest.fn(async () => ({ preference: 'off', enabled: false })) };
    const controller = new FollowsController(service as never);
    expect(await controller.setPostNotifications('author', 'viewer', { preference: 'off' }))
      .toEqual({ data: { preference: 'off', enabled: false } });
    expect(service.setPostNotificationsEnabled).toHaveBeenCalledWith({ viewerUserId: 'viewer', username: 'author', preference: 'off', enabled: undefined });
  });
});
