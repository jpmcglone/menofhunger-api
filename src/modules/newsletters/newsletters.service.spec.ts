import { BadRequestException } from '@nestjs/common';
import type { NewsletterAudienceFilter } from '../../common/dto/newsletter.dto';
import { issueNewsletterUnsubscribeToken } from './newsletter-unsubscribe-token';
import { NewslettersService } from './newsletters.service';

function makeService() {
  const newsletterRow = {
    id: 'nl-1',
    status: 'draft',
    subject: 'Hello',
    preheader: '',
    bodyJson: '{"type":"doc","content":[]}',
    ctaLabel: null,
    ctaHref: null,
    imageKey: null,
    imageUpdatedAt: null,
    scheduledAt: null,
    sentAt: null,
    createdAt: new Date(),
    updatedAt: new Date(),
    eligibleCount: 0,
    sentCount: 0,
    failedCount: 0,
    lastUserId: null,
    createdByAdminId: 'admin-1',
    audienceFilters: [] as NewsletterAudienceFilter[],
  };

  const prisma = {
    newsletter: {
      findUnique: jest.fn(async ({ where: { id } }: { where: { id: string } }) =>
        id === newsletterRow.id ? { ...newsletterRow } : null,
      ),
      findMany: jest.fn(async () => [{ ...newsletterRow }]),
      create: jest.fn(async ({ data }: { data: Record<string, unknown> }) => ({ ...newsletterRow, ...data })),
      update: jest.fn(async ({ data }: { data: Record<string, unknown> }) => ({ ...newsletterRow, ...data })),
      updateMany: jest.fn(async () => ({ count: 1 })),
    },
    user: {
      count: jest.fn(async () => 12),
      findMany: jest.fn(async () => []),
    },
  };

  const appConfig = {
    r2: () => null,
    email: () => ({
      fromEmail: {
        notifications: 'Men of Hunger <n@x.com>',
        default: 'Men of Hunger <n@x.com>',
        support: 's@x.com',
        newsletter: 'Men of Hunger <letters@x.com>',
      },
    }),
    frontendBaseUrl: () => 'https://menofhunger.com',
    browserHandoffBaseUrl: () => 'https://api.menofhunger.com/v1',
    sessionHmacSecret: () => 'test-session-hmac-secret-value',
    newsletterPostalAddress: () => '123 Main St',
  };

  const email = {
    sendText: jest.fn(async (): Promise<{ sent: boolean; reason?: string }> => ({ sent: true })),
    broadcastRemaining: jest.fn(async () => 5000),
  };

  const jobs = {
    enqueueCron: jest.fn(async () => undefined),
  };

  const prefs = {
    setEmailNewsletter: jest.fn(async () => undefined),
  };

  const svc = new NewslettersService(prisma as any, appConfig as any, email as any, jobs as any, prefs as any);
  return { svc, prisma, email, jobs, prefs, newsletterRow };
}

describe('NewslettersService', () => {
  it('eligibleWhere includes confirmed email, default-true prefs, and excludes bots/banned', () => {
    const { svc } = makeService();
    const where = svc.eligibleWhere();
    expect(where.emailVerifiedAt).toEqual({ not: null });
    expect(where.bannedAt).toBeNull();
    expect(where.isBot).toBe(false);
    expect(where.AND).toEqual([
      {
        OR: [
          { notificationPreferences: { is: null } },
          { notificationPreferences: { is: { emailNewsletter: true } } },
        ],
      },
    ]);
  });

  it('eligibleWhere stacks audience filters without dropping the email check', () => {
    const { svc } = makeService();
    const now = new Date('2026-08-31T16:00:00.000Z');
    const where = svc.eligibleWhere([{ type: 'tier', min: 'verified' }, { type: 'inactive', amount: 30, unit: 'days' }], now);
    expect(where.emailVerifiedAt).toEqual({ not: null });
    expect(where.AND).toEqual([
      {
        OR: [
          { notificationPreferences: { is: null } },
          { notificationPreferences: { is: { emailNewsletter: true } } },
        ],
      },
      {
        OR: [
          { verifiedStatus: { not: 'none' } },
          { premium: true },
          { premiumPlus: true },
        ],
      },
      {
        OR: [{ lastSeenAt: null }, { lastSeenAt: { lt: new Date('2026-08-01T16:00:00.000Z') } }],
      },
    ]);
  });

  it('sendNow claims a draft and enqueues the send job', async () => {
    const { svc, prisma, jobs, newsletterRow } = makeService();
    let status: string = 'draft';
    prisma.newsletter.findUnique.mockImplementation(async () => ({
      ...newsletterRow,
      status,
      eligibleCount: status === 'sending' ? 12 : 0,
    }));
    prisma.newsletter.updateMany.mockImplementation(async () => {
      status = 'sending';
      return { count: 1 };
    });
    const result = await svc.sendNow('nl-1');
    expect(prisma.newsletter.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: 'nl-1', status: { in: ['draft', 'scheduled'] } },
        data: expect.objectContaining({ status: 'sending', eligibleCount: 12 }),
      }),
    );
    expect(jobs.enqueueCron).toHaveBeenCalledWith(
      'newsletters.send',
      { newsletterId: 'nl-1' },
      'newsletters-send-nl-1',
      expect.any(Object),
    );
    expect(result.status).toBe('sending');
  });

  it('sendNow counts the stacked audience filters', async () => {
    const { svc, prisma, newsletterRow } = makeService();
    prisma.user.count.mockImplementation(async (args?: { where?: { AND?: unknown[] } }) => {
      const and = args?.where?.AND ?? [];
      return and.length > 1 ? 4 : 12;
    });
    let status = 'draft';
    prisma.newsletter.findUnique.mockImplementation(async () => ({
      ...newsletterRow,
      audienceFilters: [{ type: 'tier', min: 'verified' }],
      status,
      eligibleCount: status === 'sending' ? 4 : 0,
    }));
    prisma.newsletter.updateMany.mockImplementation(async () => {
      status = 'sending';
      return { count: 1 };
    });
    const result = await svc.sendNow('nl-1');
    expect(prisma.newsletter.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ eligibleCount: 4 }),
      }),
    );
    expect(result.audienceFilters).toEqual([{ type: 'tier', min: 'verified' }]);
    expect(result.eligibleCount).toBe(4);
  });

  it('refuses a second send once the row is already sent', async () => {
    const { svc, prisma, newsletterRow } = makeService();
    prisma.newsletter.findUnique.mockResolvedValue({ ...newsletterRow, status: 'sent' });
    await expect(svc.sendNow('nl-1')).rejects.toBeInstanceOf(BadRequestException);
  });

  it('sends a preview only to the current admin', async () => {
    const { svc, email } = makeService();
    const result = await svc.sendPreviewToAdmin('nl-1', {
      id: 'admin-1',
      email: 'admin@x.com',
      emailVerifiedAt: new Date(),
      name: 'James Hall',
      username: 'james',
    });
    expect(result).toEqual({ sent: true, reason: null });
    expect(email.sendText).toHaveBeenCalledWith(
      expect.objectContaining({
        to: 'admin@x.com',
        from: 'Men of Hunger <letters@x.com>',
        subject: 'Preview — Hello',
        category: 'broadcast',
        userId: 'admin-1',
        headers: expect.objectContaining({
          'List-Unsubscribe-Post': 'List-Unsubscribe=One-Click',
          'List-Id': 'Men of Hunger Newsletter <newsletter.menofhunger.com>',
        }),
      }),
    );
    const sentArgs = (email.sendText as jest.Mock).mock.calls[0]?.[0] as {
      headers: { 'List-Unsubscribe': string };
    };
    expect(sentArgs.headers['List-Unsubscribe']).toMatch(
      /^<https:\/\/api\.menofhunger\.com\/v1\/email\/unsubscribe\?token=/,
    );
  });

  it('maps a failed preview send to a human error', async () => {
    const { svc, email } = makeService();
    email.sendText.mockResolvedValue({ sent: false, reason: 'email_not_configured' });
    await expect(
      svc.sendPreviewToAdmin('nl-1', {
        id: 'admin-1',
        email: 'admin@x.com',
        emailVerifiedAt: new Date(),
        name: 'James Hall',
        username: 'james',
      }),
    ).rejects.toThrow('Email is not configured on this server.');
  });

  it('unsubscribe flips emailNewsletter off', async () => {
    const { svc, prefs } = makeService();
    const token = issueNewsletterUnsubscribeToken({
      userId: 'user-9',
      secret: 'test-session-hmac-secret-value',
    });
    await expect(svc.unsubscribeWithToken(token)).resolves.toEqual({ ok: true });
    expect(prefs.setEmailNewsletter).toHaveBeenCalledWith('user-9', false);
  });

  it('unsubscribe is idempotent on a second call', async () => {
    const { svc, prefs } = makeService();
    const token = issueNewsletterUnsubscribeToken({
      userId: 'user-9',
      secret: 'test-session-hmac-secret-value',
    });
    await svc.unsubscribeWithToken(token);
    await svc.unsubscribeWithToken(token);
    expect(prefs.setEmailNewsletter).toHaveBeenCalledTimes(2);
    expect(prefs.setEmailNewsletter).toHaveBeenLastCalledWith('user-9', false);
  });
});
