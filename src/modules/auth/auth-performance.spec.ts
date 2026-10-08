import { AuthMeService } from './auth-me.service';
import { startSpan } from '@sentry/nestjs';

jest.mock('@sentry/nestjs', () => ({
  ...jest.requireActual('@sentry/nestjs'),
  startSpan: jest.fn((_options: unknown, work: () => unknown) => work()),
}));

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((finish) => { resolve = finish; });
  return { promise, resolve };
}

describe('auth/me performance instrumentation', () => {
  it('starts independent enrichments together and preserves results while a sibling is held', async () => {
    const held = deferred<number>();
    const user = { id: 'test-user' };
    const notifications = {
      getUndeliveredCount: jest.fn(() => held.promise),
      getUnreadCommentCount: jest.fn(async () => 2),
      getGroupsUnread: jest.fn(async () => ({ total: 0, byGroupId: {} })),
    };
    const messages = { getUnreadSummary: jest.fn(async () => ({ primary: 3, requests: 0 })) };
    const controller = new AuthMeService({
      meFromSessionToken: jest.fn(async () => ({ user })),
      runMeChecks: jest.fn(async () => user),
    } as any,
    { describe: jest.fn(async () => null) } as any,
    { describe: jest.fn(async () => null) } as any,
    notifications as any, messages as any);
    let finished = false;
    const request = controller.me('fixture', {} as any)
      .then(value => { finished = true; return value; });
    for (let i = 0; i < 10; i++) await Promise.resolve();
    expect(messages.getUnreadSummary).toHaveBeenCalledTimes(1);
    expect(notifications.getUnreadCommentCount).toHaveBeenCalledTimes(1);
    expect(finished).toBe(false);
    held.resolve(7);
    const result = await request;
    expect(result.data).toMatchObject({ id: 'test-user', notificationUndeliveredCount: 7,
      notificationUnreadCommentCount: 2, messageUnreadCounts: { primary: 3, requests: 0 } });
    const names = jest.mocked(startSpan).mock.calls.map(([options]) => options.name);
    expect(names).toEqual(expect.arrayContaining(['auth.me.session', 'auth.me.checks', 'auth.me.notifications',
      'auth.me.messages', 'auth.me.groups', 'auth.me.post_count', 'auth.me.article_count',
      'auth.me.crew_invites', 'auth.me.group_invites', 'auth.me.unread_comments',
      'auth.me.impersonation', 'auth.me.account_switch']));
  });
  it('records twenty controlled phase samples without changing concurrency', async () => {
    const phases: Record<string, number[]> = {};
    const totals: number[] = [];
    jest.mocked(startSpan).mockImplementation(((options: { name: string }, work: () => unknown) => {
      const started = performance.now();
      return Promise.resolve(work()).finally(() => {
        (phases[options.name] ??= []).push(performance.now() - started);
      });
    }) as any);
    const delayed = <T>(value: T, ms: number) => new Promise<T>(resolve => setTimeout(() => resolve(value), ms));
    const user = { id: 'synthetic-user' };
    const notifications = {
      getUndeliveredCount: () => delayed(0, 30),
      getUnreadCommentCount: () => delayed(0, 10),
      getGroupsUnread: () => delayed({ total: 0, byGroupId: {} }, 15),
    };
    const messages = { getUnreadSummary: () => delayed({ primary: 0, requests: 0 }, 20) };
    const controller = new AuthMeService({
      meFromSessionToken: () => delayed({ user }, 5), runMeChecks: () => delayed(user, 5),
    } as any, { describe: async () => null } as any, { describe: async () => null } as any,
    notifications as any, messages as any);
    for (let i = 0; i < 20; i++) {
      const started = performance.now();
      const result = await controller.me('fixture', {} as any);
      totals.push(performance.now() - started);
      expect(result.data?.id).toBe(user.id);
    }
    expect(Object.keys(phases)).toHaveLength(12);
    for (const samples of Object.values(phases)) expect(samples).toHaveLength(20);
    process.stdout.write(`MOH_PERF auth_me_synthetic ${JSON.stringify({ totals, phases })}\n`);
  });

});
