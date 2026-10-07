import { AdminVerificationSlaCron } from './admin-verification-sla.cron';

function make(overdue: Array<{ id: string; createdAt: Date }>, claimed = overdue.length) {
  const prisma: any = {
    verificationRequest: {
      findMany: jest.fn(async () => overdue),
      updateMany: jest.fn(async () => ({ count: claimed })),
    },
    user: { findMany: jest.fn(async () => [{ email: 'a@x.com' }]) },
  };
  const email: any = { sendEmail: jest.fn(async () => ({ sent: true })) };
  const appConfig: any = { runSchedulers: () => true, email: () => ({}) };
  const slack: any = { notifyVerificationSlaBreached: jest.fn() };
  return { cron: new AdminVerificationSlaCron(prisma, email, appConfig, slack), prisma, email, slack };
}

describe('AdminVerificationSlaCron', () => {
  const now = new Date('2026-10-07T12:00:00Z');

  it('does nothing when no request is overdue', async () => {
    const { cron, prisma, slack } = make([]);
    await expect(cron.alertOverdue(now)).resolves.toBe(0);
    expect(prisma.verificationRequest.updateMany).not.toHaveBeenCalled();
    expect(slack.notifyVerificationSlaBreached).not.toHaveBeenCalled();
  });

  it('claims overdue requests once and alerts Slack and admins', async () => {
    const { cron, prisma, slack, email } = make([{ id: 'v1', createdAt: new Date('2026-10-06T06:00:00Z') }]);
    await expect(cron.alertOverdue(now)).resolves.toBe(1);
    expect(prisma.verificationRequest.updateMany).toHaveBeenCalledWith({
      where: { id: { in: ['v1'] }, status: 'pending', slaAlertedAt: null },
      data: { slaAlertedAt: now },
    });
    expect(slack.notifyVerificationSlaBreached).toHaveBeenCalledWith({ count: 1, oldestHours: 30 });
    expect(email.sendEmail).toHaveBeenCalledTimes(1);
  });

  it('stays quiet when another instance already claimed the rows', async () => {
    const { cron, slack } = make([{ id: 'v1', createdAt: new Date('2026-10-06T06:00:00Z') }], 0);
    await expect(cron.alertOverdue(now)).resolves.toBe(0);
    expect(slack.notifyVerificationSlaBreached).not.toHaveBeenCalled();
  });
});
