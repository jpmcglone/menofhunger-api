import { readBoardAnalytics } from './admin-analytics-board.read';

function sqlText(call: unknown[]): string {
  const query = call[0] as { strings?: string[]; sql?: string };
  return query.sql ?? (query.strings ?? []).join('?');
}

describe('readBoardAnalytics', () => {
  it('reports Board apart from posts, excluding bots and article mirrors', async () => {
    const results = [
      [{ total_threads: 12n, total_comments: 40n, threads_in_range: 3n, comments_in_range: 9n, participants_in_range: 5n }],
      [{ visibility: 'public', cnt: 10n }, { visibility: 'premiumOnly', cnt: 2n }],
      [{ bucket: new Date('2026-09-24T00:00:00Z'), count: 2n }],
      [{ bucket: new Date('2026-09-24T00:00:00Z'), count: 9n }],
      [{ cnt: 7n }],
      [{ total: 3n, answered: 2n }],
      [{
        id: 't1', title: 'Show your work', visibility: 'public', author_username: 'john',
        boost_count: 6, comment_count: 4, viewer_count: 20, total_view_count: 31,
        created_at: new Date('2026-09-24T12:00:00Z'),
      }],
    ];
    const prisma = { $queryRaw: jest.fn(async () => results.shift()) };

    const board = await readBoardAnalytics(prisma as never, { since: new Date('2026-09-18T00:00:00Z'), granularity: 'day' });

    expect(board).toMatchObject({
      totalThreads: 12,
      totalComments: 40,
      threadsInRange: 3,
      commentsInRange: 9,
      participantsInRange: 5,
      boostsInRange: 7,
      pctThreadsWithCommentWithin24h: 66.7,
      byVisibility: { public: 10, premiumOnly: 2 },
      threads: [{ bucket: '2026-09-24', count: 2 }],
      comments: [{ bucket: '2026-09-24', count: 9 }],
    });
    expect(board.topThreads[0]).toMatchObject({ id: 't1', title: 'Show your work', uniqueViewCount: 20, viewCount: 31 });

    const summarySql = sqlText(prisma.$queryRaw.mock.calls[0] as unknown[]);
    expect(summarySql).toContain(`p."kind" = 'board'`);
    expect(summarySql).toContain(`p."articleId" IS NULL`);
    expect(summarySql).toContain(`u."isBot" = false`);
  });

  it('reports the 24h answer rate as unavailable when no threads started in range', async () => {
    const results = [[{}], [], [], [], [{ cnt: 0n }], [{ total: 0n, answered: 0n }], []];
    const prisma = { $queryRaw: jest.fn(async () => results.shift()) };

    const board = await readBoardAnalytics(prisma as never, { since: null, granularity: 'month' });

    expect(board.pctThreadsWithCommentWithin24h).toBeNull();
    expect(board.totalThreads).toBe(0);
  });
});
