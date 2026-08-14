import { SpacesSideEffectsHandler } from './spaces-side-effects.handler';
import { SideEffectsRegistry } from '../side-effects/side-effects.registry';

function makeHandler() {
  const spaces = {
    getScheduleSnapshot: jest.fn(async (): Promise<{
      scheduledAt: Date | null;
      title: string;
      ownerUserId: string;
      ownerUsername: string | null;
    } | null> => ({
      scheduledAt: null,
      title: "ocaptain's space",
      ownerUserId: 'owner-1',
      ownerUsername: 'ocaptain',
    })),
    listSubscriberUserIds: jest.fn(async () => []),
    isDayReminderStillValid: jest.fn(() => true),
  };
  const notifications = {
    upsertSpaceScheduleNotification: jest.fn(async () => undefined),
    listRecipientIdsForSpaceNotification: jest.fn(async () => [] as string[]),
  };
  const registry = new SideEffectsRegistry();
  const handler = new SpacesSideEffectsHandler(spaces as any, notifications as any, registry);
  return { handler, spaces, notifications, registry };
}

describe('SpacesSideEffectsHandler registration', () => {
  it('registers live, ended, cancel, reschedule, and reminder', () => {
    const { handler, registry } = makeHandler();
    handler.onModuleInit();
    expect(registry.names()).toEqual([
      'space.schedule.cancelled',
      'space.schedule.ended',
      'space.schedule.live',
      'space.schedule.reminder',
      'space.schedule.rescheduled',
    ]);
  });
});

describe('SpacesSideEffectsHandler space.schedule.live', () => {
  it('unions schedule subscribers with people who already have a space_live row', async () => {
    const { handler, notifications } = makeHandler();
    notifications.listRecipientIdsForSpaceNotification.mockResolvedValue(['old-1', 'sub-1']);

    await (handler as any).onLive({
      spaceId: 'space-1',
      recipientUserIds: ['sub-1', 'sub-2', 'owner-1'],
    });

    const recipients = notifications.upsertSpaceScheduleNotification.mock.calls.map(
      (c: any[]) => c[0].recipientUserId,
    );
    expect(recipients.sort()).toEqual(['old-1', 'sub-1', 'sub-2']);
    expect(notifications.upsertSpaceScheduleNotification).toHaveBeenCalledWith(
      expect.objectContaining({
        kind: 'space_live',
        title: "ocaptain's space is live",
        body: 'Tap to join now.',
      }),
    );
    expect(
      (notifications.upsertSpaceScheduleNotification.mock.calls as any[]).some(
        (c) => c[0].resurface === false,
      ),
    ).toBe(false);
  });

  it('no-ops when nobody subscribed and nobody has a prior live row', async () => {
    const { handler, notifications } = makeHandler();
    await (handler as any).onLive({ spaceId: 'space-1', recipientUserIds: [] });
    expect(notifications.upsertSpaceScheduleNotification).not.toHaveBeenCalled();
  });
});

describe('SpacesSideEffectsHandler space.schedule.ended', () => {
  it('quietly retitles existing space_live rows without resurfacing', async () => {
    const { handler, notifications } = makeHandler();
    notifications.listRecipientIdsForSpaceNotification.mockResolvedValue(['sub-1']);

    await (handler as any).onEnded({ spaceId: 'space-1' });

    expect(notifications.upsertSpaceScheduleNotification).toHaveBeenCalledTimes(1);
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

  it('no-ops when nobody has a space_live row', async () => {
    const { handler, notifications } = makeHandler();
    await (handler as any).onEnded({ spaceId: 'space-1' });
    expect(notifications.upsertSpaceScheduleNotification).not.toHaveBeenCalled();
  });

  it('uses payload.spaceTitle when the space row is already gone', async () => {
    const { handler, spaces, notifications } = makeHandler();
    spaces.getScheduleSnapshot.mockResolvedValue(null);
    notifications.listRecipientIdsForSpaceNotification.mockResolvedValue(['sub-1']);

    await (handler as any).onEnded({ spaceId: 'space-1', spaceTitle: 'Morning hang' });

    expect(notifications.upsertSpaceScheduleNotification).toHaveBeenCalledWith(
      expect.objectContaining({
        title: 'Morning hang was live',
        resurface: false,
      }),
    );
  });
});
