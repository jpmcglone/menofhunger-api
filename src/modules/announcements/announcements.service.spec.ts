import { AnnouncementsService } from './announcements.service';

const NOW = new Date('2026-08-15T16:00:00.000Z');
const OLD = new Date('2026-07-01T00:00:00.000Z');

const ONBOARDED = {
  createdAt: OLD,
  premium: false,
  premiumPlus: false,
  usernameIsSet: true,
  birthdate: new Date('1990-01-01'),
  interests: ['strength_training'],
  menOnlyConfirmed: true,
};

function liveAnnouncement(overrides: Record<string, unknown> = {}) {
  return {
    id: 'a1',
    isAd: false,
    placement: 'overlay',
    title: 'Lodge note',
    body: 'Hello',
    imageKey: null,
    imageUpdatedAt: null,
    ctaLabel: null,
    ctaHref: null,
    maxViews: 1,
    publishedAt: OLD,
    endsAt: null,
    status: 'published',
    createdAt: OLD,
    updatedAt: OLD,
    ...overrides,
  };
}

function makeService(overrides: Record<string, any> = {}) {
  const prisma: any = {
    user: { findUnique: jest.fn(async () => ONBOARDED) },
    announcement: {
      findMany: jest.fn(async () => []),
      findUnique: jest.fn(async () => liveAnnouncement()),
      create: jest.fn(),
      update: jest.fn(),
      deleteMany: jest.fn(),
    },
    announcementAudience: {
      upsert: jest.fn(async () => ({ firstSeenAt: OLD })),
      findUnique: jest.fn(async () => ({ firstSeenAt: OLD })),
      deleteMany: jest.fn(),
      delete: jest.fn(),
    },
    announcementViewer: {
      findMany: jest.fn(async () => []),
      findUnique: jest.fn(async () => null),
      upsert: jest.fn(),
      update: jest.fn(),
      delete: jest.fn(),
      deleteMany: jest.fn(),
      groupBy: jest.fn(async () => []),
    },
    announcementEvent: {
      create: jest.fn(),
      updateMany: jest.fn(),
      groupBy: jest.fn(async () => []),
    },
    $transaction: jest.fn(async (arg: any) => {
      if (typeof arg === 'function') return arg(prisma);
      return Promise.all(arg);
    }),
    ...overrides,
  };
  const appConfig: any = { r2: () => ({ publicBaseUrl: 'https://cdn.example.test' }) };
  return { service: new AnnouncementsService(prisma, appConfig), prisma };
}

describe('AnnouncementsService.getPending', () => {
  it('returns the oldest unseen announcement for an onboarded member', async () => {
    const { service, prisma } = makeService();
    prisma.announcement.findMany.mockImplementation(async (args: any) => {
      if (args?.where?.isAd === false) return [liveAnnouncement({ id: 'note-1' })];
      return [];
    });

    const result = await service.getPending({ userId: 'u1', platform: 'web', now: NOW });
    expect(result?.id).toBe('note-1');
    expect(result?.isAd).toBe(false);
  });

  it('does not return announcements to guests', async () => {
    const { service, prisma } = makeService();
    prisma.user.findUnique.mockResolvedValue(null);
    prisma.announcement.findMany.mockImplementation(async (args: any) => {
      if (args?.where?.isAd === true) return [liveAnnouncement({ id: 'ad-1', isAd: true })];
      return [liveAnnouncement({ id: 'note-1' })];
    });

    const result = await service.getPending({
      anonymousId: 'anon-1234567890',
      platform: 'web',
      now: NOW,
    });
    expect(result?.id).toBe('ad-1');
  });

  it('skips ads for premium members', async () => {
    const { service, prisma } = makeService();
    prisma.user.findUnique.mockResolvedValue({ ...ONBOARDED, premium: true });
    prisma.announcement.findMany.mockImplementation(async (args: any) => {
      if (args?.where?.isAd === false) return [];
      return [liveAnnouncement({ id: 'ad-1', isAd: true })];
    });

    const result = await service.getPending({ userId: 'u1', platform: 'ios', now: NOW });
    expect(result).toBeNull();
  });

  it('prefers an announcement over an ad in the same open', async () => {
    const { service, prisma } = makeService();
    prisma.announcement.findMany.mockImplementation(async (args: any) => {
      if (args?.where?.isAd === false) return [liveAnnouncement({ id: 'note-1' })];
      return [liveAnnouncement({ id: 'ad-1', isAd: true })];
    });

    const result = await service.getPending({ userId: 'u1', platform: 'web', now: NOW });
    expect(result?.id).toBe('note-1');
  });

  it('returns the abandoned ad instead of rotating', async () => {
    const { service, prisma } = makeService();
    prisma.user.findUnique.mockResolvedValue({ ...ONBOARDED, usernameIsSet: false });
    prisma.announcement.findMany.mockImplementation(async (args: any) => {
      if (args?.where?.isAd === true) {
        return [
          liveAnnouncement({ id: 'ad-old', isAd: true }),
          liveAnnouncement({ id: 'ad-new', isAd: true, publishedAt: new Date('2026-08-01') }),
        ];
      }
      return [];
    });
    prisma.announcementViewer.findMany.mockResolvedValue([
      {
        announcementId: 'ad-new',
        lastPresentedAt: new Date('2026-08-15T15:00:00.000Z'),
        lastCompletedAt: null,
        lastOutcome: 'abandoned',
        completedCount: 0,
      },
    ]);

    const result = await service.getPending({ userId: 'u1', platform: 'web', now: NOW });
    expect(result?.id).toBe('ad-new');
  });

  it('holds ads until 12 hours after account creation', async () => {
    const { service, prisma } = makeService();
    prisma.user.findUnique.mockResolvedValue({
      ...ONBOARDED,
      createdAt: new Date(NOW.getTime() - 60 * 60 * 1000),
      usernameIsSet: false,
    });
    prisma.announcement.findMany.mockImplementation(async (args: any) => {
      if (args?.where?.isAd === true) return [liveAnnouncement({ id: 'ad-1', isAd: true })];
      return [];
    });

    const result = await service.getPending({ userId: 'u1', platform: 'web', now: NOW });
    expect(result).toBeNull();
  });

  it('does not show a completed announcement again when maxViews is 1', async () => {
    const { service, prisma } = makeService();
    prisma.announcement.findMany.mockImplementation(async (args: any) => {
      if (args?.where?.isAd === false) return [liveAnnouncement({ id: 'note-1' })];
      return [];
    });
    prisma.announcementViewer.findMany.mockResolvedValue([
      {
        announcementId: 'note-1',
        lastPresentedAt: new Date(NOW.getTime() - 2 * 60 * 60 * 1000),
        lastCompletedAt: new Date(NOW.getTime() - 2 * 60 * 60 * 1000),
        lastOutcome: 'dismissed',
        completedCount: 1,
      },
    ]);

    expect(await service.getPending({ userId: 'u1', platform: 'web', now: NOW })).toBeNull();

    const later = new Date(NOW.getTime() + 25 * 60 * 60 * 1000);
    expect(await service.getPending({ userId: 'u1', platform: 'web', now: later })).toBeNull();
  });

  it('shows again after cadence when maxViews still has room', async () => {
    const { service, prisma } = makeService();
    prisma.announcement.findMany.mockImplementation(async (args: any) => {
      if (args?.where?.isAd === false) return [liveAnnouncement({ id: 'note-1', maxViews: 2 })];
      return [];
    });
    prisma.announcementViewer.findMany.mockResolvedValue([
      {
        announcementId: 'note-1',
        lastPresentedAt: new Date(NOW.getTime() - 2 * 60 * 60 * 1000),
        lastCompletedAt: new Date(NOW.getTime() - 2 * 60 * 60 * 1000),
        lastOutcome: 'dismissed',
        completedCount: 1,
      },
    ]);

    expect(await service.getPending({ userId: 'u1', platform: 'web', now: NOW })).toBeNull();

    const later = new Date(NOW.getTime() + 23 * 60 * 60 * 1000);
    expect(await service.getPending({ userId: 'u1', platform: 'web', now: later })).toEqual(
      expect.objectContaining({ id: 'note-1' }),
    );
  });

  it('keeps web and iOS cadence separate for the same user', async () => {
    const { service, prisma } = makeService();
    prisma.announcement.findMany.mockImplementation(async (args: any) => {
      if (args?.where?.isAd === false) return [liveAnnouncement({ id: 'note-1' })];
      return [];
    });
    prisma.announcementViewer.findMany.mockImplementation(async (args: any) => {
      if (args?.where?.platform !== 'web') return [];
      return [
        {
          announcementId: 'note-1',
          lastPresentedAt: new Date(NOW.getTime() - 60 * 1000),
          lastCompletedAt: new Date(NOW.getTime() - 60 * 1000),
          lastOutcome: 'dismissed',
          completedCount: 1,
        },
      ];
    });

    expect(await service.getPending({ userId: 'u1', platform: 'web', now: NOW })).toBeNull();
    expect(await service.getPending({ userId: 'u1', platform: 'ios', now: NOW })).toEqual(
      expect.objectContaining({ id: 'note-1' }),
    );
  });

  it('shows an unseen announcement on the next open even if another was just completed', async () => {
    const { service, prisma } = makeService();
    prisma.announcement.findMany.mockImplementation(async (args: any) => {
      if (args?.where?.isAd === false) {
        return [
          liveAnnouncement({ id: 'note-1' }),
          liveAnnouncement({ id: 'note-2', publishedAt: new Date('2026-08-01') }),
        ];
      }
      return [];
    });
    prisma.announcementViewer.findMany.mockResolvedValue([
      {
        announcementId: 'note-1',
        lastPresentedAt: new Date(NOW.getTime() - 60 * 1000),
        lastCompletedAt: new Date(NOW.getTime() - 60 * 1000),
        lastOutcome: 'dismissed',
        completedCount: 1,
      },
    ]);

    const result = await service.getPending({ userId: 'u1', platform: 'web', now: NOW });
    expect(result?.id).toBe('note-2');
  });
});

describe('AnnouncementsService.recordEvent', () => {
  it('counts a dismiss as a fair view and a completion', async () => {
    const { service, prisma } = makeService();
    prisma.announcementViewer.upsert.mockResolvedValue({
      id: 'v1',
      viewCount: 0,
      lastPresentedAt: NOW,
      lastCompletedAt: null,
      lastOutcome: 'presented',
    });

    await service.recordEvent({
      announcementId: 'a1',
      userId: 'u1',
      platform: 'web',
      type: 'dismissed',
      dismissMethod: 'close_button',
      now: NOW,
    });

    expect(prisma.announcementViewer.update).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          viewCount: { increment: 1 },
          completedCount: { increment: 1 },
          lastDismissMethod: 'close_button',
        }),
      }),
    );
  });
});

describe('AnnouncementsService.reset', () => {
  it('clears viewer rows so the item is unseen again', async () => {
    const { service, prisma } = makeService();
    prisma.announcement.findUnique.mockResolvedValue(liveAnnouncement({ id: 'note-1' }));

    await service.reset('note-1');

    expect(prisma.announcementViewer.deleteMany).toHaveBeenCalledWith({
      where: { announcementId: 'note-1' },
    });
  });
});
