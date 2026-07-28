import { PresenceService } from './presence.service';

const stubDomainEvents = { emitUserStatusSet: jest.fn() } as any;

describe('PresenceService user statuses', () => {
  function makeService(prismaUser: any) {
    return new PresenceService({ presenceIdleAfterMinutes: jest.fn(), presenceIdleDisconnectMinutes: jest.fn() } as any, {
      user: prismaUser,
    } as any, stubDomainEvents);
  }

  it('filters expired statuses from active status lookups', async () => {
    const now = new Date('2026-04-25T03:00:00.000Z');
    jest.useFakeTimers().setSystemTime(now);
    const prismaUser = {
      findMany: jest.fn().mockResolvedValue([
        {
          id: 'user-active',
          statusText: 'Around tonight',
          statusSetAt: new Date('2026-04-25T02:00:00.000Z'),
          statusExpiresAt: new Date('2026-04-26T02:00:00.000Z'),
          statusPostId: null,
        },
        {
          id: 'user-expired',
          statusText: 'Old news',
          statusSetAt: new Date('2026-04-23T02:00:00.000Z'),
          statusExpiresAt: new Date('2026-04-24T02:00:00.000Z'),
          statusPostId: null,
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
        statusPostId: status.postId,
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
        postId: null,
      },
    ]);
    jest.useRealTimers();
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
          statusPostId: null,
        })
        .mockResolvedValueOnce({ id: 'user-1' }),
    };
    const service = makeService(prismaUser);

    await expect(service.setStatus('user-1', ' Working late ')).resolves.toEqual({
      userId: 'user-1',
      text: 'Working late',
      setAt: '2026-04-25T03:00:00.000Z',
      expiresAt: '2026-04-26T03:00:00.000Z',
      postId: null,
    });
    await service.clearStatus('user-1');

    expect(prismaUser.update).toHaveBeenNthCalledWith(1, expect.objectContaining({
      data: expect.objectContaining({
        statusText: 'Working late',
        statusSetAt: new Date('2026-04-25T03:00:00.000Z'),
        statusExpiresAt: new Date('2026-04-26T03:00:00.000Z'),
        statusPostId: null,
      }),
    }));
    expect(prismaUser.update).toHaveBeenNthCalledWith(2, expect.objectContaining({
      data: expect.objectContaining({
        statusText: null,
        statusSetAt: null,
        statusExpiresAt: null,
        statusPostId: null,
      }),
    }));
    jest.useRealTimers();
  });

  it('sets a status with a custom durationHours', async () => {
    jest.useFakeTimers().setSystemTime(new Date('2026-04-25T03:00:00.000Z'));
    const prismaUser = {
      update: jest.fn().mockResolvedValue({
        id: 'user-1',
        statusText: 'Quick update',
        statusSetAt: new Date('2026-04-25T03:00:00.000Z'),
        statusExpiresAt: new Date('2026-04-25T06:00:00.000Z'),
        statusPostId: null,
      }),
    };
    const service = makeService(prismaUser);

    const result = await service.setStatus('user-1', 'Quick update', 3);
    expect(result.expiresAt).toBe('2026-04-25T06:00:00.000Z');
    expect(prismaUser.update).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({
        statusExpiresAt: new Date('2026-04-25T06:00:00.000Z'),
      }),
    }));
    jest.useRealTimers();
  });

  it('editStatus updates text without changing expiry', async () => {
    jest.useFakeTimers().setSystemTime(new Date('2026-04-25T04:00:00.000Z'));
    const prismaUser = {
      update: jest.fn().mockResolvedValue({
        id: 'user-1',
        statusText: 'Updated text',
        statusSetAt: new Date('2026-04-25T03:00:00.000Z'),
        statusExpiresAt: new Date('2026-04-26T03:00:00.000Z'),
        statusPostId: 'post-abc',
      }),
    };
    const service = makeService(prismaUser);

    const { statusDto, statusPostId } = await service.editStatus('user-1', 'Updated text');
    expect(statusDto?.text).toBe('Updated text');
    expect(statusPostId).toBe('post-abc');
    // Should only update statusText, not expiresAt
    expect(prismaUser.update).toHaveBeenCalledWith(expect.objectContaining({
      data: { statusText: 'Updated text' },
    }));
    jest.useRealTimers();
  });

  it('setStatus always emits a created event so every new status notifies followers', async () => {
    jest.useFakeTimers().setSystemTime(new Date('2026-04-25T03:00:00.000Z'));
    const localStubDomainEvents = { emitUserStatusSet: jest.fn() } as any;
    const service = new PresenceService(
      { presenceIdleAfterMinutes: jest.fn(), presenceIdleDisconnectMinutes: jest.fn() } as any,
      {
        user: {
          update: jest.fn().mockResolvedValue({
            id: 'user-1',
            statusText: 'Back at it',
            statusSetAt: new Date(),
            statusExpiresAt: new Date(),
            statusPostId: 'post-1',
          }),
        },
      } as any,
      localStubDomainEvents,
    );

    await service.setStatus('user-1', 'Back at it', 24, 'post-1');
    expect(localStubDomainEvents.emitUserStatusSet).toHaveBeenCalledWith({
      userId: 'user-1',
      text: 'Back at it',
      postId: 'post-1',
      mode: 'created',
    });
    jest.useRealTimers();
  });

  it('setStatus without a post still emits a created event', async () => {
    jest.useFakeTimers().setSystemTime(new Date('2026-04-25T03:00:00.000Z'));
    const localStubDomainEvents = { emitUserStatusSet: jest.fn() } as any;
    const service = new PresenceService(
      { presenceIdleAfterMinutes: jest.fn(), presenceIdleDisconnectMinutes: jest.fn() } as any,
      {
        user: {
          update: jest.fn().mockResolvedValue({
            id: 'user-1',
            statusText: 'Quiet one',
            statusSetAt: new Date(),
            statusExpiresAt: new Date(),
            statusPostId: null,
          }),
        },
      } as any,
      localStubDomainEvents,
    );

    await service.setStatus('user-1', 'Quiet one', 24, null);
    expect(localStubDomainEvents.emitUserStatusSet).toHaveBeenCalledWith(
      expect.objectContaining({ postId: null, mode: 'created' }),
    );
    jest.useRealTimers();
  });

  it('editStatus emits an edited event so the existing notification is patched, not duplicated', async () => {
    jest.useFakeTimers().setSystemTime(new Date('2026-04-25T04:00:00.000Z'));
    const localStubDomainEvents = { emitUserStatusSet: jest.fn() } as any;
    const service = new PresenceService(
      { presenceIdleAfterMinutes: jest.fn(), presenceIdleDisconnectMinutes: jest.fn() } as any,
      {
        user: {
          update: jest.fn().mockResolvedValue({
            id: 'user-1',
            statusText: 'Reworded',
            statusSetAt: new Date('2026-04-25T03:00:00.000Z'),
            statusExpiresAt: new Date('2026-04-26T03:00:00.000Z'),
            statusPostId: 'post-abc',
          }),
        },
      } as any,
      localStubDomainEvents,
    );

    await service.editStatus('user-1', 'Reworded');
    expect(localStubDomainEvents.emitUserStatusSet).toHaveBeenCalledWith({
      userId: 'user-1',
      text: 'Reworded',
      postId: 'post-abc',
      mode: 'edited',
    });
    jest.useRealTimers();
  });
});

// ---------------------------------------------------------------------------

describe('PresenceService.markSeenFromHttp', () => {
  function makeService() {
    const prismaUser = { update: jest.fn(async () => ({})) };
    const svc = new PresenceService(
      { presenceIdleAfterMinutes: jest.fn(), presenceIdleDisconnectMinutes: jest.fn() } as any,
      { user: prismaUser } as any,
      stubDomainEvents,
    );
    return { svc, prismaUser };
  }

  it('writes lastSeenAt when the user has no live socket', () => {
    jest.useFakeTimers();
    const { svc, prismaUser } = makeService();
    svc.markSeenFromHttp('user-offline');
    expect(prismaUser.update).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({ lastSeenAt: expect.any(Date) }),
    }));
    jest.useRealTimers();
  });

  it('writes lastOnlineAt when the user has no live socket', () => {
    jest.useFakeTimers();
    const { svc, prismaUser } = makeService();
    svc.markSeenFromHttp('user-offline');
    expect(prismaUser.update).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({ lastOnlineAt: expect.any(Date) }),
    }));
    jest.useRealTimers();
  });

  it('does NOT write lastOnlineAt when the user has a live socket', () => {
    jest.useFakeTimers();
    const { svc, prismaUser } = makeService();
    // Register a fake socket so isUserOnline returns true.
    svc.register('socket-1', 'user-online', 'web');
    prismaUser.update.mockClear();
    svc.markSeenFromHttp('user-online');
    // Only one update call — for lastSeenAt, not lastOnlineAt.
    const calls = (prismaUser.update as jest.Mock).mock.calls;
    const callsWithLastOnline = calls.filter((c: any[]) =>
      Object.prototype.hasOwnProperty.call(c[0]?.data ?? {}, 'lastOnlineAt'),
    );
    expect(callsWithLastOnline).toHaveLength(0);
    jest.useRealTimers();
  });
});
