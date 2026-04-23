import { JobsService } from './jobs.service';

function makeService(overrides?: { add?: jest.Mock }) {
  const add = overrides?.add ?? jest.fn(async () => ({ id: '1' }));
  const queue = { add } as any;
  return { svc: new JobsService(queue), add };
}

describe('JobsService.enqueueCron — jobId validation', () => {
  it('throws for a 2-part colon ID (the original bug)', async () => {
    const { svc } = makeService();
    await expect(
      svc.enqueueCron('posts.popularScoreRefresh' as any, {}, 'cron:postsPopularScoreRefresh'),
    ).rejects.toThrow(/BullMQ v5/);
  });

  it('throws for a 4-part colon ID', async () => {
    const { svc } = makeService();
    await expect(
      svc.enqueueCron('posts.popularScoreRefresh' as any, {}, 'cron:a:b:c'),
    ).rejects.toThrow(/BullMQ v5/);
  });

  it('accepts a dash-separated static ID', async () => {
    const { svc, add } = makeService();
    await svc.enqueueCron('posts.popularScoreRefresh' as any, {}, 'cron-postsPopularScoreRefresh');
    expect(add).toHaveBeenCalledWith(
      'posts.popularScoreRefresh',
      {},
      expect.objectContaining({ jobId: 'cron-postsPopularScoreRefresh' }),
    );
  });

  it('accepts a 3-part colon ID (date-keyed crons)', async () => {
    const { svc, add } = makeService();
    await svc.enqueueCron('notifications.dailyDigest' as any, {}, 'cron:notificationsDailyDigest:2026-02-26');
    expect(add).toHaveBeenCalledWith(
      'notifications.dailyDigest',
      {},
      expect.objectContaining({ jobId: 'cron:notificationsDailyDigest:2026-02-26' }),
    );
  });

  it('sets removeOnComplete: true and removeOnFail: true by default', async () => {
    const { svc, add } = makeService();
    await svc.enqueueCron('posts.popularScoreRefresh' as any, {}, 'cron-postsPopularScoreRefresh');
    expect(add).toHaveBeenCalledWith(
      expect.anything(),
      expect.anything(),
      expect.objectContaining({ removeOnComplete: true, removeOnFail: true }),
    );
  });

  it('allows callers to override removeOnFail', async () => {
    const { svc, add } = makeService();
    await svc.enqueueCron('posts.popularScoreRefresh' as any, {}, 'cron-postsPopularScoreRefresh', {
      removeOnFail: false,
    });
    expect(add).toHaveBeenCalledWith(
      expect.anything(),
      expect.anything(),
      expect.objectContaining({ removeOnFail: false }),
    );
  });
});

/**
 * Registry: every static cron job ID used in the codebase listed explicitly.
 * If you add a new cron and put a colon in the ID, this test breaks — which is the point.
 */
describe('Cron job ID registry — no invalid colons', () => {
  const staticCronIds = [
    'cron-postsPopularScoreRefresh',
    'cron-hashtagsTrendingScoreRefresh',
    'cron-postsTopicsBackfill',
    'cron-postsPollResultsReadySweep',
    'cron-dailyContentRefresh',
    'cron-authCleanup',
    'cron-linkMetadataBackfill',
    'cron-searchCleanup',
    'cron-hashtagsCleanup',
    'cron-notificationsOrphanCleanup',
    'cron-notificationsCleanup',
    'cron-notificationsEmailNudges',
    'cron-notificationsReplyNudgePush',
  ];

  it.each(staticCronIds)('"%s" is a valid BullMQ v5 job ID', (id) => {
    const hasColon = id.includes(':');
    const isThreePart = id.split(':').length === 3;
    expect(hasColon && !isThreePart).toBe(false);
  });
});
