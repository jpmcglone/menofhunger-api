import { MarvinUsageService } from './marvin-usage.service';

/**
 * In-memory MarvinUsageEvent row shape — enough fields to exercise the where clauses
 * we actually use in production code.
 */
type FakeRow = {
  userId: string;
  source: 'public_thread' | 'private_session';
  rootPostId: string | null;
  errorCode: string | null;
  createdAt: Date;
};

/**
 * Smart in-memory Prisma stub: `count` actually evaluates the `where` clause against
 * the seeded rows. This is what lets us prove the sliding window truly excludes rows
 * older than `windowSeconds`, not just that we built the right SQL.
 */
function makeUsageService(seed: FakeRow[] = []) {
  const rows: FakeRow[] = [...seed];

  const matches = (row: FakeRow, where: any): boolean => {
    if (where.source != null && row.source !== where.source) return false;
    if (where.rootPostId != null && row.rootPostId !== where.rootPostId) return false;
    if (where.userId != null && row.userId !== where.userId) return false;
    if (where.errorCode === null && row.errorCode !== null) return false;
    if (where.createdAt?.gte != null && row.createdAt < where.createdAt.gte) return false;
    return true;
  };

  const prisma: any = {
    marvinUsageEvent: {
      count: jest.fn(async ({ where }: any) => rows.filter((r) => matches(r, where)).length),
      create: jest.fn(async ({ data }: any) => {
        rows.push(data);
        return data;
      }),
      findFirst: jest.fn(async () => null),
    },
  };

  const presenceRealtime: any = {
    emitMarvCreditsUpdated: jest.fn(() => undefined),
  };

  const svc = new MarvinUsageService(prisma, presenceRealtime);
  return { svc, prisma, rows };
}

const ROOT = 'r-1';
const USER = 'u-1';

describe('MarvinUsageService.countRecentRepliesForRootAndUser', () => {
  beforeEach(() => {
    jest.useFakeTimers();
    jest.setSystemTime(new Date('2026-01-01T12:00:00Z'));
  });

  afterEach(() => {
    jest.useRealTimers();
  });

  it('builds a sliding window: only counts rows newer than `now - windowSeconds`', async () => {
    const now = Date.now();
    const { svc, prisma } = makeUsageService();

    await svc.countRecentRepliesForRootAndUser({
      rootPostId: ROOT,
      userId: USER,
      windowSeconds: 60,
    });

    const call = prisma.marvinUsageEvent.count.mock.calls[0][0];
    expect(call.where).toEqual({
      source: 'public_thread',
      rootPostId: ROOT,
      userId: USER,
      errorCode: null,
      createdAt: { gte: new Date(now - 60_000) },
    });
  });

  it('counts only events within the window — older events roll off', async () => {
    const now = new Date();
    const { svc } = makeUsageService([
      // Inside the 60s window.
      { source: 'public_thread', rootPostId: ROOT, userId: USER, errorCode: null, createdAt: new Date(now.getTime() - 5_000) },
      { source: 'public_thread', rootPostId: ROOT, userId: USER, errorCode: null, createdAt: new Date(now.getTime() - 30_000) },
      // Outside the window — must NOT be counted.
      { source: 'public_thread', rootPostId: ROOT, userId: USER, errorCode: null, createdAt: new Date(now.getTime() - 61_000) },
      { source: 'public_thread', rootPostId: ROOT, userId: USER, errorCode: null, createdAt: new Date(now.getTime() - 5 * 60_000) },
    ]);

    const count = await svc.countRecentRepliesForRootAndUser({
      rootPostId: ROOT,
      userId: USER,
      windowSeconds: 60,
    });

    expect(count).toBe(2);
  });

  it('rolls off as wall-clock time advances (proves the window is sliding, not anchored)', async () => {
    const now = new Date();
    const { svc } = makeUsageService([
      { source: 'public_thread', rootPostId: ROOT, userId: USER, errorCode: null, createdAt: new Date(now.getTime() - 50_000) },
      { source: 'public_thread', rootPostId: ROOT, userId: USER, errorCode: null, createdAt: new Date(now.getTime() - 30_000) },
      { source: 'public_thread', rootPostId: ROOT, userId: USER, errorCode: null, createdAt: new Date(now.getTime() - 10_000) },
    ]);

    // t=0: all three rows are inside the 60s window.
    expect(
      await svc.countRecentRepliesForRootAndUser({ rootPostId: ROOT, userId: USER, windowSeconds: 60 }),
    ).toBe(3);

    // Advance 11s — the row at -50s is now at -61s, drops out. 2 remain.
    jest.advanceTimersByTime(11_000);
    expect(
      await svc.countRecentRepliesForRootAndUser({ rootPostId: ROOT, userId: USER, windowSeconds: 60 }),
    ).toBe(2);

    // Advance another 20s (total +31s) — the -30s row is now at -61s, drops out. 1 remains.
    jest.advanceTimersByTime(20_000);
    expect(
      await svc.countRecentRepliesForRootAndUser({ rootPostId: ROOT, userId: USER, windowSeconds: 60 }),
    ).toBe(1);

    // Advance past the freshest row (total well over 60s). 0 remain.
    jest.advanceTimersByTime(60_000);
    expect(
      await svc.countRecentRepliesForRootAndUser({ rootPostId: ROOT, userId: USER, windowSeconds: 60 }),
    ).toBe(0);
  });

  it('is scoped per user — another user in the same thread is not counted', async () => {
    const now = new Date();
    const { svc } = makeUsageService([
      // Another user mentions Marv in the same thread, in window.
      { source: 'public_thread', rootPostId: ROOT, userId: 'u-other', errorCode: null, createdAt: new Date(now.getTime() - 5_000) },
      { source: 'public_thread', rootPostId: ROOT, userId: 'u-other', errorCode: null, createdAt: new Date(now.getTime() - 10_000) },
    ]);

    expect(
      await svc.countRecentRepliesForRootAndUser({ rootPostId: ROOT, userId: USER, windowSeconds: 60 }),
    ).toBe(0);
  });

  it('is scoped per thread — same user in a different thread is not counted', async () => {
    const now = new Date();
    const { svc } = makeUsageService([
      { source: 'public_thread', rootPostId: 'r-other', userId: USER, errorCode: null, createdAt: new Date(now.getTime() - 5_000) },
      { source: 'public_thread', rootPostId: 'r-other', userId: USER, errorCode: null, createdAt: new Date(now.getTime() - 10_000) },
    ]);

    expect(
      await svc.countRecentRepliesForRootAndUser({ rootPostId: ROOT, userId: USER, windowSeconds: 60 }),
    ).toBe(0);
  });

  it('excludes private (DM) events — only public_thread is counted', async () => {
    const now = new Date();
    const { svc } = makeUsageService([
      { source: 'private_session', rootPostId: null, userId: USER, errorCode: null, createdAt: new Date(now.getTime() - 5_000) },
      { source: 'public_thread', rootPostId: ROOT, userId: USER, errorCode: null, createdAt: new Date(now.getTime() - 10_000) },
    ]);

    expect(
      await svc.countRecentRepliesForRootAndUser({ rootPostId: ROOT, userId: USER, windowSeconds: 60 }),
    ).toBe(1);
  });

  it('excludes failed replies (errorCode != null)', async () => {
    const now = new Date();
    const { svc } = makeUsageService([
      // Success — counts.
      { source: 'public_thread', rootPostId: ROOT, userId: USER, errorCode: null, createdAt: new Date(now.getTime() - 5_000) },
      // Failures of all kinds — don't count.
      { source: 'public_thread', rootPostId: ROOT, userId: USER, errorCode: 'thread_cooldown', createdAt: new Date(now.getTime() - 10_000) },
      { source: 'public_thread', rootPostId: ROOT, userId: USER, errorCode: 'ai_error', createdAt: new Date(now.getTime() - 12_000) },
      { source: 'public_thread', rootPostId: ROOT, userId: USER, errorCode: 'no_credits', createdAt: new Date(now.getTime() - 15_000) },
    ]);

    expect(
      await svc.countRecentRepliesForRootAndUser({ rootPostId: ROOT, userId: USER, windowSeconds: 60 }),
    ).toBe(1);
  });

  it('honors a custom windowSeconds argument', async () => {
    const now = new Date();
    const { svc } = makeUsageService([
      { source: 'public_thread', rootPostId: ROOT, userId: USER, errorCode: null, createdAt: new Date(now.getTime() - 10_000) },
      { source: 'public_thread', rootPostId: ROOT, userId: USER, errorCode: null, createdAt: new Date(now.getTime() - 25_000) },
      { source: 'public_thread', rootPostId: ROOT, userId: USER, errorCode: null, createdAt: new Date(now.getTime() - 100_000) },
    ]);

    // 30s window: only the first two count.
    expect(
      await svc.countRecentRepliesForRootAndUser({ rootPostId: ROOT, userId: USER, windowSeconds: 30 }),
    ).toBe(2);

    // 5s window: nothing counts.
    expect(
      await svc.countRecentRepliesForRootAndUser({ rootPostId: ROOT, userId: USER, windowSeconds: 5 }),
    ).toBe(0);

    // 200s window: all three count.
    expect(
      await svc.countRecentRepliesForRootAndUser({ rootPostId: ROOT, userId: USER, windowSeconds: 200 }),
    ).toBe(3);
  });
});
