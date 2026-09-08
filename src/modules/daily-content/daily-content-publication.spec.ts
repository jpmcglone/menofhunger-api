import { DailyContentService } from './daily-content.service';
import { DailyContentCron } from './daily-content.cron';
import { DailyContentController } from './daily-content.controller';

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

describe('daily publication', () => {
  const dayKey = '2026-09-08';
  const word = { word: 'Courage', definition: 'Strength in the face of danger.' };
  function fixture() {
    const prisma = { dailyContentSnapshot: {
      findUnique: jest.fn().mockResolvedValue(null),
      findMany: jest.fn().mockResolvedValue([]),
      upsert: jest.fn().mockResolvedValue({}),
      updateMany: jest.fn().mockResolvedValue({ count: 1 }),
    } };
    const websters = { fetchWordOfDay: jest.fn().mockResolvedValue(word) };
    const service = new DailyContentService(prisma as never, websters as never, { emitDailyContentPublished: jest.fn().mockResolvedValue(undefined) } as never);
    return { prisma, websters, service };
  }

  it('exposes content and publication timestamp together only after the full word loads', async () => {
    const { prisma, websters, service } = fixture();
    const scrape = deferred<typeof word>();
    websters.fetchWordOfDay.mockReturnValue(scrape.promise);
    const publish = service.publish({ item: 'word', dayKey });
    await Promise.resolve(); await Promise.resolve();
    expect(prisma.dailyContentSnapshot.updateMany).not.toHaveBeenCalled();
    scrape.resolve(word);
    await expect(publish).resolves.toEqual({ published: true });
    expect(prisma.dailyContentSnapshot.updateMany).toHaveBeenCalledWith(expect.objectContaining({
      data: { websters1828: word, websters1828RefreshedAt: expect.any(Date) },
    }));
  });

  it('does not mark a word ready when its definition fails to load', async () => {
    const { prisma, websters, service } = fixture();
    websters.fetchWordOfDay.mockResolvedValue({ word: 'Courage', definition: '' });
    await expect(service.publish({ item: 'word', dayKey })).rejects.toThrow('Incomplete');
    expect(prisma.dailyContentSnapshot.updateMany).not.toHaveBeenCalled();
  });

  it.each(['word', 'quote'] as const)('uses an atomic final write for %s, recovering old claims', async (item) => {
    const { prisma, service } = fixture();
    prisma.dailyContentSnapshot.findUnique.mockResolvedValue({
      websters1828RefreshedAt: new Date(1), quoteRefreshedAt: new Date(1),
    });
    await service.publish({ item, dayKey });
    const timestamp = item === 'word' ? 'websters1828RefreshedAt' : 'quoteRefreshedAt';
    expect(prisma.dailyContentSnapshot.updateMany).toHaveBeenCalledWith(expect.objectContaining({
      where: { dayKey, OR: [{ [timestamp]: null }, { [timestamp]: new Date(1) }] },
      data: expect.objectContaining({ [timestamp]: expect.any(Date) }),
    }));
    prisma.dailyContentSnapshot.updateMany.mockResolvedValue({ count: 0 });
    await expect(service.publish({ item, dayKey })).resolves.toEqual({ published: false });
  });

  it('never caches a missing snapshot across the publication boundary', async () => {
    const { service } = fixture();
    const response = { setHeader: jest.fn() };
    await new DailyContentController(service).today(response as never);
    expect(response.setHeader).toHaveBeenCalledWith('Cache-Control', 'private, no-store');
  });
});

describe('publish → invalidate → notify', () => {
  const dayKey = '2026-09-08';
  function fixture() {
    const daily = { publish: jest.fn().mockResolvedValue({ published: true }), isPublished: jest.fn().mockResolvedValue(true), isNotified: jest.fn().mockResolvedValue(false) };
    const realtime = { emitDailyContentPublished: jest.fn().mockResolvedValue(undefined) };
    const jobs = { enqueueCron: jest.fn().mockResolvedValue(undefined) };
    const cron = new DailyContentCron(jobs as never, {} as never, daily as never, realtime as never);
    return { daily, realtime, jobs, run: (item: 'word' | 'quote') => item === 'word'
      ? cron.runPublishWord({ item, dayKey }) : cron.runPublishQuote({ item, dayKey }) };
  }

  it.each(['word', 'quote'] as const)('waits for %s commit and cross-instance invalidation before enqueueing any notification', async (item) => {
    const { daily, realtime, jobs, run } = fixture();
    const commit = deferred<{ published: boolean }>();
    const invalidate = deferred<void>();
    daily.publish.mockReturnValue(commit.promise);
    realtime.emitDailyContentPublished.mockReturnValue(invalidate.promise);
    const work = run(item);
    expect(realtime.emitDailyContentPublished).not.toHaveBeenCalled();
    expect(jobs.enqueueCron).not.toHaveBeenCalled();
    commit.resolve({ published: true });
    await Promise.resolve(); await Promise.resolve(); await Promise.resolve();
    expect(realtime.emitDailyContentPublished).toHaveBeenCalledWith(item, dayKey);
    expect(jobs.enqueueCron).not.toHaveBeenCalled();
    invalidate.resolve();
    await work;
    expect(jobs.enqueueCron).toHaveBeenCalledTimes(1);
  });

  it.each(['word', 'quote'] as const)('retries %s notification enqueue even when the snapshot was already committed', async (item) => {
    const { daily, jobs, run } = fixture();
    daily.publish.mockResolvedValue({ published: false });
    jobs.enqueueCron.mockRejectedValueOnce(new Error('queue unavailable'));
    await expect(run(item)).rejects.toThrow('queue unavailable');
    await run(item);
    expect(jobs.enqueueCron).toHaveBeenCalledTimes(2);
  });

  it('does not invalidate and requeue completed days every scheduler tick', async () => {
    const { daily, realtime, jobs, run } = fixture();
    daily.isNotified.mockResolvedValue(true);
    await run('word');
    expect(realtime.emitDailyContentPublished).not.toHaveBeenCalled();
    expect(jobs.enqueueCron).not.toHaveBeenCalled();
  });

  it.each(['word', 'quote'] as const)('never notifies %s if invalidation fails', async (item) => {
    const { realtime, jobs, run } = fixture();
    realtime.emitDailyContentPublished.mockRejectedValue(new Error('Redis unavailable'));
    await expect(run(item)).rejects.toThrow('Redis unavailable');
    expect(jobs.enqueueCron).not.toHaveBeenCalled();
  });
});
