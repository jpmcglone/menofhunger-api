import { PresenceService } from './presence.service';

describe('PresenceService user statuses', () => {
  function makeService(prismaUser: any) {
    return new PresenceService({ presenceIdleAfterMinutes: jest.fn(), presenceIdleDisconnectMinutes: jest.fn() } as any, {
      user: prismaUser,
    } as any);
  }

  it('filters expired statuses from active status lookups', async () => {
    const now = new Date('2026-04-25T03:00:00.000Z');
    const prismaUser = {
      findMany: jest.fn().mockResolvedValue([
        {
          id: 'user-active',
          statusText: 'Around tonight',
          statusSetAt: new Date('2026-04-25T02:00:00.000Z'),
          statusExpiresAt: new Date('2026-04-26T02:00:00.000Z'),
        },
        {
          id: 'user-expired',
          statusText: 'Old news',
          statusSetAt: new Date('2026-04-23T02:00:00.000Z'),
          statusExpiresAt: new Date('2026-04-24T02:00:00.000Z'),
        },
      ]),
    };
    const service = makeService(prismaUser);

    const statuses = (await service.getActiveStatuses(['user-active', 'user-expired']))
      .map((status) => service.toActiveStatusDto({
        id: status.userId,
        statusText: status.text,
        statusSetAt: new Date(status.setAt),
        statusExpiresAt: new Date(status.expiresAt),
      }, now))
      .filter(Boolean);

    expect(prismaUser.findMany).toHaveBeenCalledWith(expect.objectContaining({
      where: expect.objectContaining({
        statusExpiresAt: { gt: expect.any(Date) },
      }),
    }));
    expect(statuses).toEqual([
      {
        userId: 'user-active',
        text: 'Around tonight',
        setAt: '2026-04-25T02:00:00.000Z',
        expiresAt: '2026-04-26T02:00:00.000Z',
      },
    ]);
  });

  it('sets a status with a 24 hour expiry and clears it', async () => {
    jest.useFakeTimers().setSystemTime(new Date('2026-04-25T03:00:00.000Z'));
    const prismaUser = {
      update: jest.fn()
        .mockResolvedValueOnce({
          id: 'user-1',
          statusText: 'Working late',
          statusSetAt: new Date('2026-04-25T03:00:00.000Z'),
          statusExpiresAt: new Date('2026-04-26T03:00:00.000Z'),
        })
        .mockResolvedValueOnce({ id: 'user-1' }),
    };
    const service = makeService(prismaUser);

    await expect(service.setStatus('user-1', ' Working late ')).resolves.toEqual({
      userId: 'user-1',
      text: 'Working late',
      setAt: '2026-04-25T03:00:00.000Z',
      expiresAt: '2026-04-26T03:00:00.000Z',
    });
    await service.clearStatus('user-1');

    expect(prismaUser.update).toHaveBeenNthCalledWith(1, expect.objectContaining({
      data: {
        statusText: 'Working late',
        statusSetAt: new Date('2026-04-25T03:00:00.000Z'),
        statusExpiresAt: new Date('2026-04-26T03:00:00.000Z'),
      },
    }));
    expect(prismaUser.update).toHaveBeenNthCalledWith(2, expect.objectContaining({
      data: {
        statusText: null,
        statusSetAt: null,
        statusExpiresAt: null,
      },
    }));
    jest.useRealTimers();
  });
});
