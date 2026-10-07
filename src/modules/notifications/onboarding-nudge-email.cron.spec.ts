import { OnboardingNudgeEmailCron } from './onboarding-nudge-email.cron';

const now = new Date('2026-10-14T12:00:00Z');
const DAY = 24 * 60 * 60 * 1000;

function user(overrides: Record<string, unknown> = {}) {
  return {
    id: 'u1',
    email: 'a@x.com',
    emailVerifiedAt: new Date('2026-10-01T00:00:00Z'),
    username: 'john',
    name: 'John',
    createdAt: new Date(now.getTime() - 8 * DAY),
    verifiedStatus: 'identity',
    premium: false,
    longestStreakDays: 0,
    recruitedById: null,
    onboardingNudge1SentAt: null,
    onboardingNudge3SentAt: null,
    onboardingNudge7SentAt: null,
    notificationPreferences: null,
    _count: { posts: 1, recruits: 0 },
    ...overrides,
  };
}

function make(users: ReturnType<typeof user>[]) {
  const prisma: any = {
    user: {
      findMany: jest.fn().mockResolvedValueOnce(users).mockResolvedValue([]),
      update: jest.fn(async () => ({})),
    },
  };
  const email: any = { sendText: jest.fn(async () => ({ sent: true })) };
  const appConfig: any = { runSchedulers: () => true, email: () => ({}), frontendBaseUrl: () => 'https://menofhunger.com' };
  return { cron: new OnboardingNudgeEmailCron(prisma, email, appConfig), prisma, email };
}

describe('OnboardingNudgeEmailCron', () => {
  it('sends the latest due stage and stamps every earlier stage', async () => {
    const { cron, prisma, email } = make([user()]);
    await expect(cron.run(now)).resolves.toBe(1);
    expect(email.sendText).toHaveBeenCalledTimes(1);
    expect(email.sendText.mock.calls[0][0].text).toContain('/invite');
    const data = prisma.user.update.mock.calls[0][0].data;
    expect(Object.keys(data).sort()).toEqual(['onboardingNudge1SentAt', 'onboardingNudge3SentAt', 'onboardingNudge7SentAt']);
  });

  it('stamps without sending when the member opted out', async () => {
    const { cron, prisma, email } = make([user({ notificationPreferences: { emailOnboarding: false } })]);
    await expect(cron.run(now)).resolves.toBe(0);
    expect(email.sendText).not.toHaveBeenCalled();
    expect(prisma.user.update).toHaveBeenCalledTimes(1);
  });

  it('does not stamp when the send fails so it can retry', async () => {
    const { cron, prisma, email } = make([user()]);
    email.sendText.mockResolvedValueOnce({ sent: false, reason: 'email_quota_engagement_limit' });
    await expect(cron.run(now)).resolves.toBe(0);
    expect(prisma.user.update).not.toHaveBeenCalled();
  });

  it('skips members whose due stages are already sent', async () => {
    const stamped = new Date(now.getTime() - DAY);
    const { cron, email } = make([user({ onboardingNudge1SentAt: stamped, onboardingNudge3SentAt: stamped, onboardingNudge7SentAt: stamped })]);
    await expect(cron.run(now)).resolves.toBe(0);
    expect(email.sendText).not.toHaveBeenCalled();
  });
});
