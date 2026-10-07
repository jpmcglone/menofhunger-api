import { PrismaClient } from '@prisma/client';
import { PostViewsService } from './post-views.service';
import { PostsTopicsBackfillCron } from '../posts/posts-topics-backfill.cron';

import { PostsReadService } from '../posts-read/posts-read.service';
// This gate is deliberately limited to check-database.sh's disposable database.
const url = process.env.MOH_ERASURE_FIXTURE_DATABASE_URL;
const enabled = url && new URL(url).hostname === '127.0.0.1' && new URL(url).pathname === '/moh_erasure_fixture';
(enabled ? describe : describe.skip)('Sentry batching regressions (PostgreSQL)', () => {
  const db = new PrismaClient({ datasources: { db: { url: url ?? 'postgresql://invalid/never-connect' } }, log: [{ emit: 'event', level: 'query' }] });
  const queries: string[] = [];
  db.$on('query', event => queries.push(event.query));
  const notifications = { markReadBySubjects: jest.fn(), markReadBySubject: jest.fn() };
  const analytics = { capture: jest.fn() };
  const service = new PostViewsService(db as any, {} as any,
    { del: async () => undefined, setString: async () => true } as any,
    { bumpForYouUser: async () => undefined } as any,
    { emitPostsLiveUpdated: jest.fn(), emitPostsLiveUpdatedToUser: jest.fn() } as any,
    analytics as any, notifications as any, new PostsReadService(db as any as never));
  let userId: string;
  let ids: string[];
  const anon = 'sentry_batch_browser';
  beforeAll(async () => {
    const user = await db.user.create({ data: { username: 'sentry_batch_fixture', phone: '+15550000567' } });
    userId = user.id;
  });
  beforeEach(async () => {
    jest.clearAllMocks();
    await db.post.deleteMany({ where: { userId } });
    await db.viewerIdentity.deleteMany({ where: { anonId: anon } });
    ids = [];
    for (let i = 0; i < 12; i++) {
      const post = await db.post.create({ data: { userId, body: 'ok', visibility: 'public', viewerCount: 0, totalViewCount: 0, weightedViewCount: 0 } });
      ids.push(post.id);
    }
  });
  afterAll(async () => { await db.$disconnect(); });

  it('counts one unique impression under concurrent guest batches and repeated reports', async () => {
    const batches = await Promise.all(Array.from({ length: 4 }, () => service.markViewedBatch(null, ids, anon, 'feed_scroll')));
    expect(batches.every(batch => batch.length === ids.length)).toBe(true);
    expect(batches.flat().filter(ack => ack.uniqueCounted)).toHaveLength(ids.length);
    expect(await db.postAnonView.count({ where: { anonId: anon } })).toBe(ids.length);
    const posts = await db.post.findMany({ where: { id: { in: ids } } });
    expect(posts.every(post => post.viewerCount === 1 && post.totalViewCount === 1 && post.weightedViewCount === 0.5)).toBe(true);
    expect(notifications.markReadBySubject).not.toHaveBeenCalled();
    expect(notifications.markReadBySubjects).not.toHaveBeenCalled();
  });

  it('uses the same number of database statements for one or twelve new guest views', async () => {
    queries.length = 0;
    expect(await service.markViewedBatch(null, ids.slice(0, 1), 'sentry_single_browser', 'feed_scroll')).toHaveLength(1);
    const singleCount = queries.length;
    queries.length = 0;
    expect(await service.markViewedBatch(null, ids, anon, 'feed_scroll')).toHaveLength(ids.length);
    expect(queries.length).toBe(singleCount);
    expect(queries.length).toBeLessThan(15);
  });

  it('refreshes total views without adding another person, and later refreshes weight', async () => {
    await service.markViewedBatch(null, ids, anon, 'feed_scroll');
    await db.postAnonView.updateMany({ where: { anonId: anon }, data: { lastImpressionAt: new Date(Date.now() - 60_000) } });
    const acks = await service.markViewedBatch(null, ids, anon, 'feed_scroll');
    expect(acks.every(ack => !ack.uniqueCounted && ack.totalCounted && ack.viewerCount === 1 && ack.totalViewCount === 2)).toBe(true);
    await db.postAnonView.updateMany({ where: { anonId: anon }, data: { lastViewedAt: new Date(0), lastImpressionAt: new Date(0) } });
    await service.markViewedBatch(null, ids, anon, 'feed_scroll');
    const posts = await db.post.findMany({ where: { id: { in: ids } } });
    expect(posts.every(post => post.viewerCount === 1 && post.totalViewCount === 3 && post.weightedViewCount === 1)).toBe(true);
  });

  it('excludes private/deleted posts and records opens only for the requested Board post', async () => {
    await db.post.update({ where: { id: ids[0] }, data: { visibility: 'onlyMe' } });
    await db.post.update({ where: { id: ids[1] }, data: { deletedAt: new Date() } });
    await db.post.updateMany({ where: { id: { in: [ids[2], ids[3]] } }, data: { kind: 'board' } });
    await db.post.update({ where: { id: ids[2] }, data: { quotedPostId: ids[3] } });
    const acks = await service.markViewedBatch(null, ids.slice(0, 3), anon, 'post_open');
    expect(acks.map(ack => ack.id).sort()).toEqual([ids[2], ids[3]].sort());
    const views = await db.postAnonView.findMany({ where: { anonId: anon } });
    expect(views.find(view => view.postId === ids[2])?.openCount).toBe(1);
    expect(views.find(view => view.postId === ids[3])?.openCount).toBe(0);
    expect(analytics.capture).toHaveBeenCalledTimes(1);
  });

  it('keeps previously authenticated viewers out of guest counts', async () => {
    await service.markViewedBatch(userId, ids, anon, 'feed_scroll');
    const acks = await service.markViewedBatch(null, ids, anon, 'feed_scroll');
    expect(acks).toHaveLength(ids.length);
    expect(acks.every(ack => !ack.uniqueCounted && !ack.totalCounted)).toBe(true);
    expect(await db.postAnonView.count({ where: { anonId: anon } })).toBe(0);
  });

  it('backfills different topic sets in one batch and leaves classified rows alone', async () => {
    await db.post.update({ where: { id: ids[0] }, data: { body: '#faith', hashtags: ['faith'] } });
    await db.post.update({ where: { id: ids[1] }, data: { topics: ['gaming'], topicsClassifiedAt: new Date() } });
    const cron = new PostsTopicsBackfillCron(db as any, { enqueueCron: jest.fn() } as any, {} as any);
    await cron.runBackfill({ batchSize: 5000 });
    const rows = await db.post.findMany({ where: { id: { in: ids } } });
    expect(rows.find(row => row.id === ids[0])?.topics).toContain('faith');
    expect(rows.find(row => row.id === ids[1])?.topics).toEqual(['gaming']);
    expect(rows.filter(row => ids.slice(2).includes(row.id)).every(row => row.topicsClassifiedAt !== null)).toBe(true);
  });
  it('does not overwrite a post edited after the topic batch was read', async () => {
    const findMany = db.post.findMany.bind(db.post);
    const read = jest.spyOn(db.post as any, 'findMany').mockImplementationOnce(async (args: any) => {
      const rows = await findMany(args);
      await db.post.update({ where: { id: ids[0] }, data: { body: 'new content', topics: ['gaming'] } });
      return rows;
    });
    try {
      const cron = new PostsTopicsBackfillCron(db as any, { enqueueCron: jest.fn() } as any, {} as any);
      await cron.runBackfill({ batchSize: 5000 });
      expect(await db.post.findUnique({ where: { id: ids[0] } })).toMatchObject({ body: 'new content', topics: ['gaming'], topicsClassifiedAt: null });
    } finally { read.mockRestore(); }
  });

});
