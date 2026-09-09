import { AdminEngagementService } from './admin-engagement.service';

describe('admin engagement snapshots', () => {
  it('returns full counts independently of the bounded unanswered preview', async () => {
    const prisma: any = {
      verificationRequest: { count: jest.fn(async () => 2) }, report: { count: jest.fn(async () => 1) },
      feedback: { count: jest.fn(async () => 3) }, stripeWebhookEvent: { count: jest.fn(async () => 4), findFirst: jest.fn(async () => null) },
      post: { count: jest.fn().mockResolvedValueOnce(5).mockResolvedValueOnce(20), findMany: jest.fn(async () => [{ id: 'p', body: 'Hello', user: { username: 'john' }, createdAt: new Date() }]) },
    };
    const result = await new AdminEngagementService(prisma).attention();
    expect(result.items.find(i => i.id === 'unanswered')?.count).toBe(20);
    expect(result.items.find(i => i.id === 'unanswered')?.path).toBe('/admin/attention/conversations');
    expect(result.unansweredPosts).toHaveLength(1);
    expect(result.items.find(i => i.id === 'verification')?.count).toBe(2);
    expect(prisma.post.findMany.mock.calls[0][0].where.replies.none.user.isBot).toBe(false);
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
