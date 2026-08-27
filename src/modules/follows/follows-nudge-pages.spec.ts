import { NotFoundException } from '@nestjs/common';
import { FollowsService } from './follows.service';

function makeService(opts: {
  viewerKind?: 'person' | 'page';
  targetKind?: 'person' | 'page';
}) {
  const prisma: any = {
    user: {
      findFirst: jest.fn(async () => ({
        id: 'target',
        username: 'target',
        followVisibility: 'all',
        accountKind: opts.targetKind ?? 'person',
      })),
      findUnique: jest.fn(async () => ({
        verifiedStatus: 'identity',
        accountKind: opts.viewerKind ?? 'person',
      })),
    },
    follow: {
      findFirst: jest.fn(async () => ({ id: 'f', postNotificationsEnabled: true })),
    },
    notification: { findFirst: jest.fn(async () => null) },
  };
  const notifications = { create: jest.fn(async () => undefined) };
  const viewerContext = { assertUserIdNotBanned: jest.fn(async () => undefined) };
  const service = new FollowsService(
    prisma,
    { r2: jest.fn(() => null) } as any,
    notifications as any,
    { dispatch: jest.fn() } as any,
    { getJson: jest.fn(), setJson: jest.fn() } as any,
    {} as any,
    viewerContext as any,
    {} as any,
  );
  return { service, notifications };
}

describe('FollowsService.nudge — page accounts', () => {
  it('hides the surface when the viewer is a page', async () => {
    const { service, notifications } = makeService({ viewerKind: 'page' });
    await expect(service.nudge({ viewerUserId: 'news', username: 'target' })).rejects.toBeInstanceOf(
      NotFoundException,
    );
    expect(notifications.create).not.toHaveBeenCalled();
  });

  it('hides the surface when the target is a page', async () => {
    const { service, notifications } = makeService({ targetKind: 'page' });
    await expect(service.nudge({ viewerUserId: 'john', username: 'news' })).rejects.toBeInstanceOf(
      NotFoundException,
    );
    expect(notifications.create).not.toHaveBeenCalled();
  });
});
