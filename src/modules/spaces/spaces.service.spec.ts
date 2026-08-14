import { SpacesService } from './spaces.service';

function build(overrides: {
  prisma?: Record<string, any>;
  notifications?: Record<string, any>;
  realtime?: Record<string, any>;
  sideEffects?: Record<string, any>;
  jobs?: Record<string, any>;
  spacesPresence?: Record<string, any>;
  appConfig?: Record<string, any>;
  linkMetadata?: Record<string, any>;
  posthog?: Record<string, any>;
} = {}) {
  const prisma: any = {
    space: {
      findUnique: jest.fn(),
      delete: jest.fn(async () => undefined),
      update: jest.fn(),
      updateMany: jest.fn(),
    },
    spaceScheduleSubscriber: {
      findMany: jest.fn(async () => []),
      count: jest.fn(async () => 0),
      deleteMany: jest.fn(async () => ({ count: 0 })),
      findUnique: jest.fn(async () => null),
      upsert: jest.fn(),
    },
    follow: { findUnique: jest.fn(async () => null) },
    ...overrides.prisma,
  };
  const notifications = {
    upsertSpaceScheduleNotification: jest.fn(async () => undefined),
    listRecipientIdsForSpaceNotification: jest.fn(async () => [] as string[]),
    ...overrides.notifications,
  };
  const realtime = {
    emitSpacesUpdated: jest.fn(),
    ...overrides.realtime,
  };
  const sideEffects = {
    dispatch: jest.fn(),
    ...overrides.sideEffects,
  };
  const jobs = {
    removeById: jest.fn(async () => undefined),
    add: jest.fn(async () => undefined),
    ...overrides.jobs,
  };
  const spacesPresence = {
    getLobbyCountsBySpaceId: jest.fn(() => ({})),
    ...overrides.spacesPresence,
  };
  const appConfig = {
    r2: jest.fn(() => null),
    ...overrides.appConfig,
  };
  const linkMetadata = {
    getMetadata: jest.fn(async () => null),
    ...overrides.linkMetadata,
  };

  const posthog = { capture: jest.fn(), ...overrides.posthog };
  const service = new SpacesService(
    prisma,
    appConfig as any,
    spacesPresence as any,
    sideEffects as any,
    jobs as any,
    realtime as any,
    notifications as any,
    linkMetadata as any,
    posthog as any,
  );
  return { service, prisma, notifications, realtime, sideEffects, jobs, linkMetadata, posthog };
}

describe('SpacesService.deleteSpace', () => {
  it('writes cancel notifications before deleting the space row', async () => {
    const order: string[] = [];
    const { service, notifications, realtime, sideEffects } = build({
      prisma: {
        space: {
          findUnique: jest.fn(async () => ({
            ownerId: 'owner-1',
            title: 'Morning hang',
            scheduledAt: new Date(Date.now() + 3_600_000),
            owner: { username: 'host' },
          })),
          delete: jest.fn(async () => {
            order.push('delete');
          }),
        },
        spaceScheduleSubscriber: {
          findMany: jest.fn(async () => [{ userId: 'sub-1' }, { userId: 'owner-1' }]),
          count: jest.fn(async () => 1),
          deleteMany: jest.fn(async () => ({ count: 0 })),
          findUnique: jest.fn(async () => null),
        },
      },
      notifications: {
        upsertSpaceScheduleNotification: jest.fn(async () => {
          order.push('notify');
        }),
      },
    });

    await service.deleteSpace('space-1', 'owner-1');

    expect(order).toEqual(['notify', 'delete']);
    expect(notifications.upsertSpaceScheduleNotification).toHaveBeenCalledWith(
      expect.objectContaining({
        recipientUserId: 'sub-1',
        kind: 'space_schedule_cancelled',
        spaceId: 'space-1',
      }),
    );
    expect(sideEffects.dispatch).not.toHaveBeenCalledWith(
      'space.schedule.cancelled',
      expect.anything(),
    );
    expect(sideEffects.dispatch).not.toHaveBeenCalledWith(
      'space.schedule.ended',
      expect.anything(),
    );
    expect(realtime.emitSpacesUpdated).toHaveBeenCalledWith(
      expect.objectContaining({
        spaceId: 'space-1',
        reason: 'deleted',
        patch: expect.objectContaining({ deleted: true }),
      }),
    );
  });

  it('retitles existing space_live rows before deleting so subjectSpaceId is still set', async () => {
    const order: string[] = [];
    const { service, notifications } = build({
      prisma: {
        space: {
          findUnique: jest.fn(async () => ({
            ownerId: 'owner-1',
            title: "ocaptain's space",
            scheduledAt: null,
            owner: { username: 'ocaptain' },
          })),
          delete: jest.fn(async () => {
            order.push('delete');
          }),
        },
      },
      notifications: {
        listRecipientIdsForSpaceNotification: jest.fn(async () => ['sub-1']),
        upsertSpaceScheduleNotification: jest.fn(async () => {
          order.push('notify');
        }),
      },
    });

    await service.deleteSpace('space-1', 'owner-1');

    expect(order).toEqual(['notify', 'delete']);
    expect(notifications.upsertSpaceScheduleNotification).toHaveBeenCalledWith({
      recipientUserId: 'sub-1',
      kind: 'space_live',
      spaceId: 'space-1',
      actorUserId: 'owner-1',
      title: "ocaptain's space was live",
      body: "It's no longer live.",
      resurface: false,
    });
  });
});

describe('SpacesService.activateSpace', () => {
  it('dispatches live fan-out with no new recipients when there was no schedule', async () => {
    const { service, prisma, sideEffects } = build({
      prisma: {
        space: {
          findUnique: jest.fn(async () => ({
            ownerId: 'owner-1',
            scheduledAt: null,
          })),
          update: jest.fn(async () => ({
            id: 'space-1',
            title: 'Hang',
            description: null,
            isActive: true,
            scheduledAt: null,
            mode: 'NONE',
            watchPartyUrl: null,
            radioStreamUrl: null,
            owner: {
              id: 'owner-1',
              username: 'host',
              avatarKey: null,
              avatarUpdatedAt: null,
              premium: false,
              premiumPlus: false,
              isOrganization: false,
              verifiedStatus: 'none',
            },
            _count: { scheduleSubscribers: 0 },
          })),
        },
        spaceScheduleSubscriber: {
          findMany: jest.fn(async () => []),
          count: jest.fn(async () => 0),
          deleteMany: jest.fn(async () => ({ count: 0 })),
          findUnique: jest.fn(async () => null),
        },
      },
    });

    await service.activateSpace('space-1', 'owner-1');

    expect(sideEffects.dispatch).toHaveBeenCalledWith('space.schedule.live', {
      spaceId: 'space-1',
      recipientUserIds: [],
    });
    expect(prisma.spaceScheduleSubscriber.deleteMany).toHaveBeenCalledWith({
      where: { spaceId: 'space-1', userId: { not: 'owner-1' } },
    });
  });

  it('snapshots recipients then clears non-owner subscribers when going live from schedule', async () => {
    const scheduledAt = new Date(Date.now() + 3_600_000);
    const { service, sideEffects, prisma } = build({
      prisma: {
        space: {
          findUnique: jest.fn(async () => ({
            ownerId: 'owner-1',
            scheduledAt,
          })),
          update: jest.fn(async () => ({
            id: 'space-1',
            title: 'Hang',
            description: null,
            isActive: true,
            scheduledAt: null,
            mode: 'NONE',
            watchPartyUrl: null,
            radioStreamUrl: null,
            owner: {
              id: 'owner-1',
              username: 'host',
              avatarKey: null,
              avatarUpdatedAt: null,
              premium: false,
              premiumPlus: false,
              isOrganization: false,
              verifiedStatus: 'none',
            },
            _count: { scheduleSubscribers: 2 },
          })),
        },
        spaceScheduleSubscriber: {
          findMany: jest.fn(async () => [{ userId: 'sub-1' }, { userId: 'owner-1' }]),
          count: jest.fn(async () => 0),
          deleteMany: jest.fn(async () => ({ count: 1 })),
          findUnique: jest.fn(async () => null),
        },
      },
    });

    await service.activateSpace('space-1', 'owner-1');

    expect(sideEffects.dispatch).toHaveBeenCalledWith('space.schedule.live', {
      spaceId: 'space-1',
      recipientUserIds: ['sub-1'],
    });
    expect(prisma.spaceScheduleSubscriber.deleteMany).toHaveBeenCalled();
  });
});

const SPACE_ROW = {
  id: 'space-1',
  title: 'Hang',
  description: null,
  isActive: false,
  scheduledAt: null,
  mode: 'NONE' as const,
  watchPartyUrl: null,
  radioStreamUrl: null,
  owner: {
    id: 'owner-1',
    username: 'host',
    avatarKey: null,
    avatarUpdatedAt: null,
    premium: false,
    premiumPlus: false,
    isOrganization: false,
    verifiedStatus: 'none' as const,
  },
  _count: { scheduleSubscribers: 0 },
};

describe('SpacesService.deactivateSpace', () => {
  it('dispatches ended so existing live notifications retitle in place', async () => {
    const { service, sideEffects } = build({
      prisma: {
        space: {
          findUnique: jest.fn(async () => ({ ownerId: 'owner-1' })),
          update: jest.fn(async () => SPACE_ROW),
        },
      },
    });

    await service.deactivateSpace('space-1', 'owner-1');

    expect(sideEffects.dispatch).toHaveBeenCalledWith('space.schedule.ended', { spaceId: 'space-1' });
  });
});

describe('SpacesService.deactivateIfActive', () => {
  it('dispatches ended only when a live space actually flipped off', async () => {
    const flipped = build({
      prisma: {
        space: {
          updateMany: jest.fn(async () => ({ count: 1 })),
          findUnique: jest.fn(async () => ({ ownerId: 'owner-1', mode: 'NONE' })),
        },
      },
    });
    await expect(flipped.service.deactivateIfActive('space-1')).resolves.toBe(true);
    expect(flipped.sideEffects.dispatch).toHaveBeenCalledWith('space.schedule.ended', {
      spaceId: 'space-1',
    });

    const skipped = build({
      prisma: {
        space: { updateMany: jest.fn(async () => ({ count: 0 })) },
      },
    });
    await expect(skipped.service.deactivateIfActive('space-1')).resolves.toBe(false);
    expect(skipped.sideEffects.dispatch).not.toHaveBeenCalled();
  });
});

describe('SpacesService.isDayReminderStillValid', () => {
  it('rejects past schedules and mismatched ms', () => {
    const { service } = build();
    const scheduledAt = new Date('2026-08-15T00:00:00.000Z');
    expect(service.isDayReminderStillValid(scheduledAt, scheduledAt.getTime() - 1)).toBe(false);
    expect(
      service.isDayReminderStillValid(scheduledAt, scheduledAt.getTime(), scheduledAt.getTime() + 1),
    ).toBe(false);
  });
});

describe('SpacesService.setMode playbackTitle', () => {
  function ownerRow(overrides: Record<string, unknown> = {}) {
    return {
      id: 'space-1',
      title: "host's Space",
      description: null,
      isActive: true,
      scheduledAt: null,
      mode: 'NONE',
      watchPartyUrl: null,
      radioStreamUrl: null,
      owner: {
        id: 'owner-1',
        username: 'host',
        avatarKey: null,
        avatarUpdatedAt: null,
        premium: false,
        premiumPlus: false,
        isOrganization: false,
        verifiedStatus: 'none',
      },
      _count: { scheduleSubscribers: 0 },
      ...overrides,
    };
  }

  it('emits the radio station name on mode_changed', async () => {
    const { RADIO_STATIONS } = await import('../radio/radio.constants');
    const station = RADIO_STATIONS[0]!;
    const { service, realtime } = build({
      prisma: {
        space: {
          findUnique: jest.fn(async () => ({ ownerId: 'owner-1' })),
          update: jest.fn(async () =>
            ownerRow({
              mode: 'RADIO',
              radioStreamUrl: station.streamUrl,
            }),
          ),
        },
      },
    });

    const dto = await service.setMode('space-1', 'owner-1', {
      mode: 'RADIO',
      radioStreamUrl: station.streamUrl,
    });

    expect(dto.playbackTitle).toBe(station.name);
    expect(realtime.emitSpacesUpdated).toHaveBeenCalledWith(
      expect.objectContaining({
        reason: 'mode_changed',
        patch: expect.objectContaining({
          mode: 'RADIO',
          radioStreamUrl: station.streamUrl,
          playbackTitle: station.name,
        }),
      }),
    );
  });

  it('emits the YouTube OG title after prefetching metadata', async () => {
    const fetchSpy = jest.spyOn(global, 'fetch').mockResolvedValue({
      ok: false,
      json: async () => ({}),
    } as Response);
    const getMetadata = jest.fn(async () => ({ title: 'Conference talk' }));
    const { service, realtime, linkMetadata } = build({
      prisma: {
        space: {
          findUnique: jest.fn(async () => ({ ownerId: 'owner-1' })),
          update: jest.fn(async () =>
            ownerRow({
              mode: 'WATCH_PARTY',
              watchPartyUrl: 'https://youtu.be/dQw4w9WgXcQ',
            }),
          ),
        },
      },
      linkMetadata: { getMetadata },
    });

    const dto = await service.setMode('space-1', 'owner-1', {
      mode: 'WATCH_PARTY',
      watchPartyUrl: 'https://youtu.be/dQw4w9WgXcQ',
    });

    expect(linkMetadata.getMetadata).toHaveBeenCalledWith('https://youtu.be/dQw4w9WgXcQ');
    expect(dto.playbackTitle).toBe('Conference talk');
    expect(realtime.emitSpacesUpdated).toHaveBeenCalledWith(
      expect.objectContaining({
        reason: 'mode_changed',
        patch: expect.objectContaining({
          mode: 'WATCH_PARTY',
          playbackTitle: 'Conference talk',
        }),
      }),
    );
    fetchSpy.mockRestore();
  });

  it('prefers the YouTube oEmbed title over scraped OG', async () => {
    const fetchSpy = jest.spyOn(global, 'fetch').mockResolvedValue({
      ok: true,
      json: async () => ({ title: 'THE GREAT DEBATE' }),
    } as Response);
    const getMetadata = jest.fn(async () => ({ title: 'YouTube' }));
    const { service, linkMetadata } = build({
      prisma: {
        space: {
          findUnique: jest.fn(async () => ({ ownerId: 'owner-1' })),
          update: jest.fn(async () =>
            ownerRow({
              mode: 'WATCH_PARTY',
              watchPartyUrl: 'https://youtu.be/dQw4w9WgXcQ',
            }),
          ),
        },
      },
      linkMetadata: { getMetadata },
    });

    const dto = await service.setMode('space-1', 'owner-1', {
      mode: 'WATCH_PARTY',
      watchPartyUrl: 'https://youtu.be/dQw4w9WgXcQ',
    });

    expect(dto.playbackTitle).toBe('THE GREAT DEBATE');
    expect(linkMetadata.getMetadata).not.toHaveBeenCalled();
    fetchSpy.mockRestore();
  });

  it('emits null playbackTitle for NONE', async () => {
    const getMetadata = jest.fn(async () => ({ title: 'nope' }));
    const { service, realtime } = build({
      prisma: {
        space: {
          findUnique: jest.fn(async () => ({ ownerId: 'owner-1' })),
          update: jest.fn(async () => ownerRow({ mode: 'NONE' })),
        },
      },
      linkMetadata: { getMetadata },
    });

    const dto = await service.setMode('space-1', 'owner-1', { mode: 'NONE' });
    expect(dto.playbackTitle).toBeNull();
    expect(getMetadata).not.toHaveBeenCalled();
    expect(realtime.emitSpacesUpdated).toHaveBeenCalledWith(
      expect.objectContaining({
        patch: expect.objectContaining({ playbackTitle: null }),
      }),
    );
  });
});

describe('SpacesService.listLobbySpaces', () => {
  it('queries live, scheduled, own, and occupied rooms', async () => {
    const findMany = jest.fn(async () => []);
    const { service } = build({
      prisma: {
        space: { findMany },
        spaceScheduleSubscriber: {
          findMany: jest.fn(async () => []),
          count: jest.fn(async () => 0),
          createMany: jest.fn(),
        },
        follow: { findMany: jest.fn(async () => []) },
      },
      spacesPresence: {
        getLobbyCountsBySpaceId: jest.fn(() => ({ 'occupied-1': 3 })),
      },
    });

    await expect(service.listLobbySpaces('viewer-1')).resolves.toEqual([]);
    expect(findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: {
          OR: expect.arrayContaining([
            { isActive: true },
            { scheduledAt: { gt: expect.any(Date) } },
            { ownerId: 'viewer-1' },
            { id: { in: ['occupied-1'] } },
          ]),
        },
      }),
    );
  });
});

describe('SpacesService.countNonOwnerSubscribers', () => {
  it('counts where userId is not the owner', async () => {
    const { service, prisma } = build({
      prisma: {
        spaceScheduleSubscriber: {
          count: jest.fn(async () => 3),
          findMany: jest.fn(async () => []),
          deleteMany: jest.fn(),
          findUnique: jest.fn(),
        },
      },
    });
    await expect(service.countNonOwnerSubscribers('space-1', 'owner-1')).resolves.toBe(3);
    expect(prisma.spaceScheduleSubscriber.count).toHaveBeenCalledWith({
      where: { spaceId: 'space-1', userId: { not: 'owner-1' } },
    });
  });
});

describe('SpacesService analytics', () => {
  const ownerRow = {
    id: 'space-1',
    title: 'Hang',
    description: null,
    isActive: false,
    scheduledAt: null,
    mode: 'NONE' as const,
    watchPartyUrl: null,
    radioStreamUrl: null,
    owner: {
      id: 'owner-1',
      username: 'host',
      avatarKey: null,
      avatarUpdatedAt: null,
      premium: false,
      premiumPlus: false,
      isOrganization: false,
      verifiedStatus: 'none',
    },
    _count: { scheduleSubscribers: 0 },
  };

  it('captures space_created', async () => {
    const { service, posthog } = build({
      prisma: {
        space: {
          findUnique: jest.fn(async () => null),
          create: jest.fn(async () => ownerRow),
        },
      },
    });
    await service.createSpace('owner-1', { title: 'Hang' });
    expect(posthog.capture).toHaveBeenCalledWith('owner-1', 'space_created', { space_id: 'space-1' });
  });

  it('captures space_activated and writes activatedAt', async () => {
    const { service, prisma, posthog } = build({
      prisma: {
        space: {
          findUnique: jest.fn(async () => ({ ownerId: 'owner-1', scheduledAt: null, mode: 'RADIO' })),
          update: jest.fn(async () => ({ ...ownerRow, isActive: true, mode: 'RADIO' })),
        },
      },
    });
    await service.activateSpace('space-1', 'owner-1');
    expect(prisma.space.update).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({ isActive: true, activatedAt: expect.any(Date) }),
    }));
    expect(posthog.capture).toHaveBeenCalledWith('owner-1', 'space_activated', {
      space_id: 'space-1',
      mode: 'RADIO',
      had_schedule: false,
    });
  });

  it('captures space_deactivated with owner reason', async () => {
    const { service, posthog } = build({
      prisma: {
        space: {
          findUnique: jest.fn(async () => ({ ownerId: 'owner-1' })),
          update: jest.fn(async () => ownerRow),
        },
      },
    });
    await service.deactivateSpace('space-1', 'owner-1');
    expect(posthog.capture).toHaveBeenCalledWith('owner-1', 'space_deactivated', {
      space_id: 'space-1',
      mode: 'NONE',
      reason: 'owner',
    });
  });

  it('captures space_mode_set with from_mode', async () => {
    const { service, posthog } = build({
      prisma: {
        space: {
          findUnique: jest.fn(async () => ({ ownerId: 'owner-1', mode: 'NONE' })),
          update: jest.fn(async () => ({
            ...ownerRow,
            mode: 'RADIO',
            radioStreamUrl: 'https://ice1.somafm.com/dronezone-128-mp3',
          })),
        },
      },
    });
    await service.setMode('space-1', 'owner-1', {
      mode: 'RADIO',
      radioStreamUrl: 'https://ice1.somafm.com/dronezone-128-mp3',
    });
    expect(posthog.capture).toHaveBeenCalledWith('owner-1', 'space_mode_set', {
      space_id: 'space-1',
      mode: 'RADIO',
      from_mode: 'NONE',
      has_watch_party_url: false,
      has_radio_url: true,
    });
  });
});
