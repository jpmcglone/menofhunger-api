import { AdminNewMemberPostsCron } from './admin-new-member-posts.cron';

const now = new Date('2026-10-07T12:00:00Z');

function post(id: string) {
  return {
    id,
    createdAt: new Date('2026-10-07T08:00:00Z'),
    body: 'Hello everyone',
    visibility: 'public',
    user: { id: `u-${id}`, username: `man${id}`, name: 'Man', createdAt: new Date('2026-10-05T00:00:00Z') },
  };
}

function make(posts: ReturnType<typeof post>[], seen: string[] = []) {
  const prisma: any = {
    post: { findMany: jest.fn(async () => posts) },
    adminEmailLog: {
      findMany: jest.fn(async () => seen.map((dayKey) => ({ dayKey }))),
      create: jest.fn(async () => ({})),
    },
  };
  const slack: any = { isConfigured: true, notifyNewMemberPostsWaiting: jest.fn() };
  const appConfig: any = { runSchedulers: () => true };
  return { cron: new AdminNewMemberPostsCron(prisma, appConfig, slack), prisma, slack };
}

describe('AdminNewMemberPostsCron', () => {
  it('alerts once for each waiting post and records the claim', async () => {
    const { cron, prisma, slack } = make([post('a'), post('b')]);
    await expect(cron.alertWaiting(now)).resolves.toBe(2);
    expect(prisma.adminEmailLog.create).toHaveBeenCalledTimes(2);
    expect(slack.notifyNewMemberPostsWaiting).toHaveBeenCalledTimes(1);
  });

  it('skips posts already alerted', async () => {
    const { cron, slack } = make([post('a')], ['a']);
    await expect(cron.alertWaiting(now)).resolves.toBe(0);
    expect(slack.notifyNewMemberPostsWaiting).not.toHaveBeenCalled();
  });

  it('skips a post another instance claimed first', async () => {
    const { cron, prisma, slack } = make([post('a')]);
    prisma.adminEmailLog.create.mockRejectedValueOnce(new Error('unique'));
    await expect(cron.alertWaiting(now)).resolves.toBe(0);
    expect(slack.notifyNewMemberPostsWaiting).not.toHaveBeenCalled();
  });
});
