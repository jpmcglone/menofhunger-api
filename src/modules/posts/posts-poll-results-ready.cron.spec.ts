import { PostsPollResultsReadyCron } from './posts-poll-results-ready.cron';

describe('PostsPollResultsReadyCron.runPollResultsReadySweep', () => {
  function makeCron(opts?: {
    polls?: Array<{
      id: string;
      postId: string;
      post: { userId: string; body: string | null };
      _count: { votes: number };
    }>;
    voters?: Array<{ userId: string }>;
    lockCount?: number;
    deletedAt?: Date | null;
  }) {
    const polls = opts?.polls ?? [
      {
        id: 'poll-1',
        postId: 'post-1',
        post: { userId: 'author-1', body: 'Who wins?' },
        _count: { votes: 2 },
      },
    ];
    const voters = opts?.voters ?? [{ userId: 'voter-1' }, { userId: 'voter-2' }];
    const lockCount = opts?.lockCount ?? 1;
    const deletedAt = opts?.deletedAt ?? null;

    const tx = {
      post: {
        findUnique: jest.fn(async () => ({ deletedAt })),
      },
      postPoll: {
        updateMany: jest.fn(async () => ({ count: lockCount })),
      },
      postPollVote: {
        findMany: jest.fn(async () => voters),
      },
    };

    const prisma = {
      postPoll: {
        findMany: jest.fn(async () => polls),
      },
      $transaction: jest.fn(async (fn: (t: typeof tx) => Promise<unknown>) => fn(tx)),
    };

    const notifications = {
      create: jest.fn(async () => undefined),
    };
    const jobs = { enqueueCron: jest.fn() };
    const appConfig = { runSchedulers: jest.fn(() => true) };

    const cron = new PostsPollResultsReadyCron(
      prisma as any,
      notifications as any,
      jobs as any,
      appConfig as any,
    );

    return { cron, prisma, tx, notifications };
  }

  it('notifies author and every distinct voter via NotificationsService.create', async () => {
    const { cron, notifications } = makeCron();

    await cron.runPollResultsReadySweep();

    expect(notifications.create).toHaveBeenCalledTimes(3);

    expect(notifications.create).toHaveBeenCalledWith({
      recipientUserId: 'author-1',
      kind: 'poll_results_ready',
      subjectPostId: 'post-1',
      title: 'Your poll got a few votes · 2 votes',
      body: 'Who wins?',
    });

    expect(notifications.create).toHaveBeenCalledWith({
      recipientUserId: 'voter-1',
      kind: 'poll_results_ready',
      actorUserId: 'author-1',
      subjectPostId: 'post-1',
      title: 'Poll results are in · 2 votes',
      body: 'Who wins?',
    });

    expect(notifications.create).toHaveBeenCalledWith({
      recipientUserId: 'voter-2',
      kind: 'poll_results_ready',
      actorUserId: 'author-1',
      subjectPostId: 'post-1',
      title: 'Poll results are in · 2 votes',
      body: 'Who wins?',
    });
  });

  it('omits actorUserId for the author so create() does not self-skip', async () => {
    const { cron, notifications } = makeCron({
      voters: [{ userId: 'author-1' }],
    });

    await cron.runPollResultsReadySweep();

    // Author who also voted is still only notified once (Set dedupe).
    expect(notifications.create).toHaveBeenCalledTimes(1);
    const calls = notifications.create.mock.calls as unknown as Array<[Record<string, unknown>]>;
    const authorCall = calls[0]?.[0];
    expect(authorCall).toEqual(
      expect.objectContaining({
        recipientUserId: 'author-1',
        title: 'Your poll got a few votes · 2 votes',
      }),
    );
    expect(authorCall?.actorUserId).toBeUndefined();
  });

  it('skips notification creation when the claim lock loses', async () => {
    const { cron, notifications } = makeCron({ lockCount: 0 });

    await cron.runPollResultsReadySweep();

    expect(notifications.create).not.toHaveBeenCalled();
  });

  it('skips notification creation when the post was deleted', async () => {
    const { cron, notifications } = makeCron({ deletedAt: new Date() });

    await cron.runPollResultsReadySweep();

    expect(notifications.create).not.toHaveBeenCalled();
  });
});
