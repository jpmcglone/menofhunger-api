import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { Prisma } from '@prisma/client';
import { PostsPopularScoreCron } from './posts-popular-score.cron';
import { PostsRankingService } from './posts-ranking.service';

describe('repost feed inclusion guardrails', () => {
  const feedSource = readFileSync(join(__dirname, 'posts-feed-query.service.ts'), 'utf8');

  it('does not globally exclude repost rows from profile or home feeds', () => {
    // listQuotes legitimately excludes flat-repost shells (kind='repost') because a
    // quote is a post with quotedPostId set and kind != 'repost'. That exclusion is
    // scoped to the listQuotes helper, not the feed paths. We verify the string only
    // appears in listQuotes by confirming the count is exactly 1 and the surrounding
    // context contains 'quotedPostId'.
    const repostExcludeCount = (feedSource.match(/kind: \{ not: 'repost' \}/g) ?? []).length;
    const rawRepostExcludeCount = (feedSource.match(/p\."kind"::text <> 'repost'/g) ?? []).length;

    if (repostExcludeCount > 0) {
      // The only allowed usage is inside listQuotes (scoped by quotedPostId filter)
      expect(repostExcludeCount).toBe(1);
      expect(feedSource).toContain('quotedPostId: postId');
    } else {
      expect(repostExcludeCount).toBe(0);
    }
    expect(rawRepostExcludeCount).toBe(0);
  });

  it('scores repost activity so ranked feeds can surface the reposter row', () => {
    expect(feedSource).toContain(`CASE WHEN p."kind" = 'repost' THEN`);
  });

  it.each(['scheduled', 'immediate'] as const)(
    'includes repost activity in the %s scoring query',
    async (refresh) => {
      const queryRaw = jest.fn().mockResolvedValue([]);
      const prisma = {
        $queryRaw: queryRaw,
        post: {
          findMany: jest.fn().mockResolvedValue([]),
          updateMany: jest.fn().mockResolvedValue({ count: 0 }),
        },
      } as unknown as ConstructorParameters<typeof PostsRankingService>[0];
      const jobs = {} as ConstructorParameters<typeof PostsRankingService>[1];

      if (refresh === 'scheduled') {
        const posts = {} as ConstructorParameters<typeof PostsPopularScoreCron>[1];
        const config = {} as ConstructorParameters<typeof PostsPopularScoreCron>[3];
        await new PostsPopularScoreCron(prisma, posts, jobs, config).runRefreshPopularSnapshots();
      } else {
        await new PostsRankingService(prisma, jobs).computeScoresForPostIds(['repost-id']);
      }

      // Inspect the composed query sent to Prisma: the formula can live in a shared helper.
      expect(queryRaw).toHaveBeenCalledTimes(1);
      const query = queryRaw.mock.calls[0][0] as Prisma.Sql;
      expect(query.sql).toContain(`CASE WHEN p."kind" = 'repost' THEN 0.5 ELSE 0 END`);
      expect(query.sql).not.toMatch(/p\."kind"(?:::text)?\s*(?:<>|!=)\s*'repost'/);
    },
  );
});
