import { AdminEngagementService, summarizeAttentionPulse, utcDayMs } from './admin-engagement.service';

function engagementPrisma() {
  return {
    verificationRequest: {
      count: jest.fn(async () => 2),
      findFirst: jest.fn(async () => ({ createdAt: new Date('2026-08-05T00:00:00.000Z') })),
    },
    report: { count: jest.fn(async () => 1) },
    feedback: { count: jest.fn(async () => 3) },
    stripeWebhookEvent: { count: jest.fn(async () => 4), findFirst: jest.fn(async () => null) },
    post: {
      count: jest.fn(async ({ where }: { where: any }) => where.scheduledFailedAt ? 5 : 20),
      findMany: jest.fn(async ({ where }: { where: any }) => {
        if (where.replies?.none && where.user?.accountKind === 'person') {
          return [{ id: 'member-post', body: 'Building this week', user: { username: 'ocaptain' }, createdAt: new Date('2026-09-08T12:00:00.000Z') }];
        }
        if (where.replies?.none) {
          return [{ id: 'official-post', body: 'Lodge news', user: { username: 'menofhunger' }, createdAt: new Date('2026-09-07T12:00:00.000Z') }];
        }
        return [{
          userId: 'member-1',
          createdAt: new Date('2026-09-08T12:00:00.000Z'),
          replies: [{ createdAt: new Date('2026-09-08T15:00:00.000Z') }],
        }];
      }),
      findFirst: jest.fn(async () => ({ id: 'lodge-prompt', replies: [] })),
    },
    userDailyActivity: { findMany: jest.fn(async () => [{ userId: 'member-1', day: new Date('2026-09-09T00:00:00.000Z') }]) },
  };
}

describe('admin engagement snapshots', () => {
  it('returns full counts independently of the bounded unanswered preview', async () => {
    const prisma: any = engagementPrisma();
    const result = await new AdminEngagementService(prisma).attention();
    expect(result.items.find(i => i.id === 'unanswered')?.count).toBe(20);
    expect(result.items.find(i => i.id === 'unanswered')?.path).toBe('/admin/attention/conversations');
    expect(result.items.find(i => i.id === 'unanswered')?.detail).toContain('Member posts are listed first');
    expect(result.unansweredPosts.map(post => post.id)).toEqual(['member-post', 'official-post']);
    expect(result.items.find(i => i.id === 'verification')?.count).toBe(2);
    expect(result.pulse.verificationPending).toBe(2);
    expect(result.pulse.oldestVerificationRequestedAt).toBe('2026-08-05T00:00:00.000Z');
    expect(result.pulse.lodgePromptId).toBe('lodge-prompt');
    expect(result.pulse.lodgePromptReplies).toBe(0);
    expect(prisma.post.findMany.mock.calls.some((call: [{ where: any }]) => call[0].where.replies?.none?.user?.isBot === false)).toBe(true);
  });

  it('lists member unanswered posts before official posts and fills the preview', async () => {
    const prisma: any = engagementPrisma();
    prisma.post.findMany = jest.fn(async ({ where, take }: { where: any; take?: number }) => {
      if (where.replies?.none && where.user?.accountKind === 'person') {
        return Array.from({ length: take ?? 8 }, (_, index) => ({
          id: `member-${index}`, body: 'Member post', user: { username: 'ocaptain' }, createdAt: new Date(),
        }));
      }
      if (where.replies?.none) {
        throw new Error('official preview should not load when members fill the list');
      }
      return [];
    });
    const result = await new AdminEngagementService(prisma).attention();
    expect(result.unansweredPosts).toHaveLength(8);
    expect(result.unansweredPosts.every(post => post.id.startsWith('member-'))).toBe(true);
  });

  it('keeps complete cohort totals when drilling into one stage and binds pagination parameters', async () => {
    const result = { counts: { joined: 100, verified: 70, contributed: 50, returned: 30 }, members: [], matching: 20 };
    const prisma: any = { $queryRaw: jest.fn(async () => [result]) };
    const data = await new AdminEngagementService(prisma).activation({ days: 90, stage: 'contributed', offset: 25, limit: 25 });
    expect(data.counts.joined).toBe(100);
    expect(data.matching).toBe(20);
    expect(data.offset).toBe(25);
    const sql = prisma.$queryRaw.mock.calls[0][0];
    expect(sql.values).toContain('contributed');
    expect(sql.sql).toContain('FROM cohort');
    expect(data.definitions.join(' ')).toContain('UTC');
  });
});

describe('attention pulse', () => {
  it('measures 24-hour human replies and later-day returns without using official posts', () => {
    const now = new Date('2026-09-10T12:00:00.000Z');
    const pulse = summarizeAttentionPulse({
      now,
      since: new Date('2026-09-03T12:00:00.000Z'),
      roots: [
        { userId: 'a', createdAt: new Date('2026-09-08T12:00:00.000Z'), firstHumanReplyAt: new Date('2026-09-09T11:00:00.000Z') },
        { userId: 'b', createdAt: new Date('2026-09-08T12:00:00.000Z'), firstHumanReplyAt: new Date('2026-09-09T13:00:00.000Z') },
        { userId: 'c', createdAt: new Date('2026-09-09T12:00:00.000Z'), firstHumanReplyAt: null },
      ],
      activityDays: [
        { userId: 'a', day: new Date('2026-09-09T00:00:00.000Z') },
        { userId: 'b', day: new Date('2026-09-08T00:00:00.000Z') },
      ],
      lodge: { id: 'prompt', humanReplies: 0 },
      verificationPending: 4,
      oldestVerificationRequestedAt: new Date('2026-08-05T00:00:00.000Z'),
    });
    expect(pulse.memberRoots).toBe(3);
    expect(pulse.repliedWithin24h).toBe(1);
    expect(pulse.replyRate24hPct).toBe(33.3);
    expect(pulse.authors).toBe(3);
    expect(pulse.authorsReturned).toBe(1);
    expect(pulse.authorsReturnedPct).toBe(33.3);
    expect(pulse.lodgePromptReplies).toBe(0);
    expect(pulse.definitions.join(' ')).toContain('Pages and site admins');
  });

  it('returns null rates and lodge fields when there is nothing to measure', () => {
    const pulse = summarizeAttentionPulse({
      now: new Date('2026-09-10T12:00:00.000Z'),
      since: new Date('2026-09-03T12:00:00.000Z'),
      roots: [],
      activityDays: [],
      lodge: null,
      verificationPending: 0,
      oldestVerificationRequestedAt: null,
    });
    expect(pulse.replyRate24hPct).toBeNull();
    expect(pulse.authorsReturnedPct).toBeNull();
    expect(pulse.lodgePromptId).toBeNull();
    expect(pulse.lodgePromptReplies).toBeNull();
    expect(utcDayMs(new Date('2026-09-09T18:30:00.000Z'))).toBe(Date.UTC(2026, 8, 9));
  });
});
