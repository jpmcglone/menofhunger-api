import { SpacesSideEffectsHandler } from './spaces-side-effects.handler';
import { SideEffectsRegistry } from '../side-effects/side-effects.registry';

function makeHandler() {
  const spaces = {
    getScheduleSnapshot: jest.fn(async (): Promise<{
      scheduledAt: Date | null;
      title: string;
      eventTitle: string;
      ownerUserId: string;
      ownerUsername: string | null;
    } | null> => ({
      scheduledAt: null,
      title: "ocaptain's space",
      eventTitle: "ocaptain's space",
      ownerUserId: 'owner-1',
      ownerUsername: 'ocaptain',
    })),
    listSubscriberUserIds: jest.fn(async () => []),
    listFollowerUserIds: jest.fn(async () => [] as string[]),
    listAudienceUserIds: jest.fn(async () => [] as string[]),
    isDayReminderStillValid: jest.fn(() => true),
  };
  const notifications = {
    upsertSpaceScheduleNotification: jest.fn(async () => undefined),
    listRecipientIdsForSpaceNotification: jest.fn(async () => [] as string[]),
  };
  const sideEffects = { dispatch: jest.fn() };
  const prisma = { user: { findUnique: jest.fn(async (): Promise<any> => null) } };
  const email = { sendText: jest.fn(async () => ({ sent: true })) };
  const appConfig = {
    email: jest.fn((): any => null),
    frontendBaseUrl: jest.fn(() => 'https://menofhunger.com'),
  };
  const registry = new SideEffectsRegistry();
  const handler = new SpacesSideEffectsHandler(
    spaces as any,
    notifications as any,
    registry,
    sideEffects as any,
    prisma as any,
    email as any,
    appConfig as any,
  );
  return { handler, spaces, notifications, registry, sideEffects, email, prisma, appConfig };
}

describe('SpacesSideEffectsHandler registration', () => {
  it('registers live, ended, cancel, reschedule, reminder, and announce', () => {
    const { handler, registry } = makeHandler();
    handler.onModuleInit();
    expect(registry.names()).toEqual([
      'space.schedule.announce.chunk',
      'space.schedule.announced',
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

describe('SpacesSideEffectsHandler space.schedule.announced', () => {
  const scheduledSnap = {
    scheduledAt: new Date('2026-09-15T20:00:00.000Z'),
    title: "ocaptain's space",
    eventTitle: "ocaptain's space",
    ownerUserId: 'owner-1',
    ownerUsername: 'ocaptain',
  };

  it('writes followed_space to followers and skips the host', async () => {
    const { handler, spaces, notifications } = makeHandler();
    spaces.getScheduleSnapshot.mockResolvedValue(scheduledSnap);
    spaces.listFollowerUserIds.mockResolvedValue(['fan-1', 'owner-1']);

    await (handler as any).onAnnounced({ spaceId: 'space-1' });

    const recipients = notifications.upsertSpaceScheduleNotification.mock.calls.map(
      (c: any[]) => c[0].recipientUserId,
    );
    expect(recipients).toEqual(['fan-1']);
    expect(notifications.upsertSpaceScheduleNotification).toHaveBeenCalledWith(
      expect.objectContaining({
        kind: 'followed_space',
        spaceId: 'space-1',
        title: "ocaptain's space scheduled",
      }),
    );
  });

  it('emails followers who have the followed-article pref on', async () => {
    const { handler, spaces, notifications, email, prisma, appConfig } = makeHandler();
    spaces.getScheduleSnapshot.mockResolvedValue(scheduledSnap);
    spaces.listFollowerUserIds.mockResolvedValue(['fan-1']);
    appConfig.email.mockReturnValue({
      fromEmail: { default: 'hello@x.com', notifications: 'n@x.com', newsletter: 'l@x.com' },
    });
    prisma.user.findUnique.mockResolvedValue({
      id: 'fan-1',
      email: 'fan@example.com',
      emailVerifiedAt: new Date('2026-01-01T00:00:00.000Z'),
      name: 'Fan',
      username: 'fan',
      notificationPreferences: { emailFollowedArticle: true },
    });

    await (handler as any).onAnnounced({ spaceId: 'space-1' });

    expect(notifications.upsertSpaceScheduleNotification).toHaveBeenCalled();
    expect(email.sendText).toHaveBeenCalledWith(
      expect.objectContaining({
        to: 'fan@example.com',
        category: 'engagement',
        userId: 'fan-1',
      }),
    );
  });

  it('skips email when the followed-article pref is off', async () => {
    const { handler, spaces, email, prisma, appConfig } = makeHandler();
    spaces.getScheduleSnapshot.mockResolvedValue(scheduledSnap);
    spaces.listFollowerUserIds.mockResolvedValue(['fan-1']);
    appConfig.email.mockReturnValue({
      fromEmail: { default: 'hello@x.com', notifications: 'n@x.com', newsletter: 'l@x.com' },
    });
    prisma.user.findUnique.mockResolvedValue({
      id: 'fan-1',
      email: 'fan@example.com',
      emailVerifiedAt: new Date('2026-01-01T00:00:00.000Z'),
      name: 'Fan',
      username: 'fan',
      notificationPreferences: { emailFollowedArticle: false },
    });

    await (handler as any).onAnnounced({ spaceId: 'space-1' });

    expect(email.sendText).not.toHaveBeenCalled();
  });

  it('no-ops when there is no schedule', async () => {
    const { handler, notifications } = makeHandler();
    await (handler as any).onAnnounced({ spaceId: 'space-1' });
    expect(notifications.upsertSpaceScheduleNotification).not.toHaveBeenCalled();
  });

  it('uses the custom event title in the announce row', async () => {
    const { handler, spaces, notifications } = makeHandler();
    spaces.getScheduleSnapshot.mockResolvedValue({
      ...scheduledSnap,
      title: "ocaptain's space",
      eventTitle: 'The Great Debate',
    });
    spaces.listFollowerUserIds.mockResolvedValue(['fan-1']);

    await (handler as any).onAnnounced({ spaceId: 'space-1' });

    expect(notifications.upsertSpaceScheduleNotification).toHaveBeenCalledWith(
      expect.objectContaining({ title: 'The Great Debate scheduled' }),
    );
  });
});

describe('SpacesSideEffectsHandler space.schedule.reminder soon', () => {
  it('notifies followers and subscribers, and emails followers', async () => {
    const { handler, spaces, notifications, email, prisma, appConfig } = makeHandler();
    const scheduledAt = new Date(Date.now() + 30 * 60 * 1000);
    spaces.getScheduleSnapshot.mockResolvedValue({
      scheduledAt,
      title: 'The Great Debate',
      eventTitle: 'The Great Debate',
      ownerUserId: 'owner-1',
      ownerUsername: 'ocaptain',
    });
    spaces.listAudienceUserIds.mockResolvedValue(['fan-1', 'sub-1']);
    appConfig.email.mockReturnValue({
      fromEmail: { default: 'hello@x.com', notifications: 'n@x.com', newsletter: 'l@x.com' },
    });
    prisma.user.findUnique.mockResolvedValue({
      id: 'fan-1',
      email: 'fan@example.com',
      emailVerifiedAt: new Date('2026-01-01T00:00:00.000Z'),
      name: 'Fan',
      username: 'fan',
      notificationPreferences: { emailFollowedArticle: true },
    });

    await (handler as any).onReminder({
      spaceId: 'space-1',
      kind: 'space_reminder_soon',
      scheduledAtMs: scheduledAt.getTime(),
    });

    const recipients = notifications.upsertSpaceScheduleNotification.mock.calls.map(
      (c: any[]) => c[0].recipientUserId,
    );
    expect(recipients.sort()).toEqual(['fan-1', 'owner-1', 'sub-1']);
    expect(notifications.upsertSpaceScheduleNotification).toHaveBeenCalledWith(
      expect.objectContaining({
        kind: 'space_reminder_soon',
        body: 'Starts in about 30 minutes.',
      }),
    );
    expect(email.sendText).toHaveBeenCalledWith(
      expect.objectContaining({
        subject: expect.stringContaining('starts in 30 minutes'),
      }),
    );
  });
});

describe('SpacesSideEffectsHandler space.schedule.cancelled', () => {
  it('emails the audience when the space row is already gone', async () => {
    const { handler, spaces, notifications, email, prisma, appConfig } = makeHandler();
    spaces.getScheduleSnapshot.mockResolvedValue(null);
    appConfig.email.mockReturnValue({
      fromEmail: { default: 'hello@x.com', notifications: 'n@x.com', newsletter: 'l@x.com' },
    });
    prisma.user.findUnique.mockResolvedValue({
      id: 'fan-1',
      email: 'fan@example.com',
      emailVerifiedAt: new Date('2026-01-01T00:00:00.000Z'),
      name: 'Fan',
      username: 'fan',
      notificationPreferences: { emailFollowedArticle: true },
    });

    await (handler as any).onCancelled({
      spaceId: 'space-1',
      ownerUserId: 'owner-1',
      spaceTitle: 'The Great Debate',
      ownerUsername: 'ocaptain',
      recipientUserIds: ['fan-1'],
    });

    expect(notifications.upsertSpaceScheduleNotification).not.toHaveBeenCalled();
    expect(email.sendText).toHaveBeenCalledWith(
      expect.objectContaining({
        to: 'fan@example.com',
        subject: 'The Great Debate was cancelled',
      }),
    );
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
