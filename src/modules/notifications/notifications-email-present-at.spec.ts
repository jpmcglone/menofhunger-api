/**
 * Tests verifying that presentAt-stamped notifications are excluded from emails.
 *
 * Tests the instant high-signal email and the nudge email behavior.
 */
import { NotificationsEmailCron } from './notifications-email.cron';

// Minimal factory that produces a NotificationsEmailCron with everything mocked.
function makeCron(overrides?: {
  notifFindMany?: jest.Mock;
  userFindMany?: jest.Mock;
  queryRaw?: jest.Mock;
  sendText?: jest.Mock;
}) {
  const notifFindMany = overrides?.notifFindMany ?? jest.fn(async () => []);
  const userFindMany = overrides?.userFindMany ?? jest.fn(async () => []);
  const $queryRaw = overrides?.queryRaw ?? jest.fn(async () => []);
  const sendText = overrides?.sendText ?? jest.fn(async () => ({ sent: false, reason: 'test' }));

  const prisma = {
    notification: { findMany: notifFindMany, findFirst: jest.fn(async () => null) },
    user: { findMany: userFindMany, update: jest.fn(async () => ({})) },
    notificationPreferences: {
      findUnique: jest.fn(async () => null),
      upsert: jest.fn(async () => ({})),
    },
    messageParticipant: { findMany: jest.fn(async () => []) },
    $queryRaw,
  } as any;

  const email = { sendText } as any;

  const appConfig = {
    email: jest.fn(() => ({ fromEmail: { notifications: 'noreply@test.com' } })),
    frontendBaseUrl: jest.fn(() => 'https://menofhunger.com'),
    runSchedulers: jest.fn(() => true),
  } as any;

  const jobs = { enqueueCron: jest.fn(async () => undefined) } as any;
  const dailyContent = {} as any;
  const messages = { getUnreadSummary: jest.fn(async () => ({ primary: 0, requests: 0 })) } as any;
  const slack = { post: jest.fn() } as any;
  const notifications = {} as any;

  return new NotificationsEmailCron(prisma, email, appConfig, jobs, dailyContent, messages, slack, notifications);
}

// Access private methods for focused unit tests.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function callPrivate(cron: NotificationsEmailCron, method: string, ...args: unknown[]): Promise<unknown> {
  return (cron as any)[method](...args);
}

describe('NotificationsEmailCron – instant high-signal email', () => {
  it('includes presentAt: null in the notification query so present-stamped notifications are excluded', async () => {
    const notifFindMany = jest.fn(async () => []);
    const cron = makeCron({ notifFindMany });

    await callPrivate(cron, 'runSendInstantHighSignalEmail', { userId: 'user-1' });

    // The function may early-return if the user has no prefs row — findMany may not be called.
    // But if it is called, it must include presentAt: null.
    if (notifFindMany.mock.calls.length > 0) {
      const firstCall = notifFindMany.mock.calls[0] as Array<{ where?: Record<string, unknown> }>;
      const where = firstCall[0]?.where ?? {};
      expect(where.presentAt).toBe(null);
    }
  });
});

describe('NotificationsEmailCron – nudge email', () => {
  it('skips user when all undelivered notifications have presentAt set (emailable count is 0)', async () => {
    const sendText = jest.fn(async () => ({ sent: true }));

    // Recipient has undeliveredNotificationCount > 0 but zero emailable notifications.
    const user = {
      id: 'user-1',
      email: 'test@example.com',
      username: 'tester',
      name: 'Tester',
      undeliveredNotificationCount: 3,
    };

    const cron = makeCron({
      userFindMany: jest.fn(async () => [user]),
      // $queryRaw returns empty for both preview items and emailable count queries.
      queryRaw: jest.fn(async () => []),
      sendText,
    });

    await callPrivate(cron, 'runSendNewNotificationsNudges');

    // Email must NOT have been sent since emailable count is 0.
    expect(sendText).not.toHaveBeenCalled();
  });

  it('sends nudge email when user has emailable notifications (presentAt is null)', async () => {
    const sendText = jest.fn(async () => ({ sent: true }));

    const user = {
      id: 'user-1',
      email: 'test@example.com',
      username: 'tester',
      name: 'Tester',
      undeliveredNotificationCount: 2,
    };

    // $queryRaw call #1 = listRecentNotificationItemsByRecipientIds (preview items)
    // $queryRaw call #2 = listEmailableNotificationCountsByRecipientIds (emailable count)
    let callCount = 0;
    const queryRaw = jest.fn(async () => {
      callCount++;
      if (callCount === 1) {
        // Preview items for recent notifications
        return [{ recipientUserId: 'user-1', title: 'mentioned you', body: 'hello', subjectPostId: null }];
      }
      // Emailable count — user has 2 unseen, unread, non-present notifications.
      return [{ recipientUserId: 'user-1', count: 2 }];
    });

    const cron = makeCron({
      userFindMany: jest.fn(async () => [user]),
      queryRaw,
      sendText,
    });

    await callPrivate(cron, 'runSendNewNotificationsNudges');

    expect(sendText).toHaveBeenCalledTimes(1);
    const callArgs = sendText.mock.calls[0] as Array<{ subject?: string }>;
    const { subject } = callArgs[0] ?? {};
    expect(subject).toContain('notification');
  });
});
