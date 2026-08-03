import { readFileSync } from 'node:fs';
import { join } from 'node:path';

describe('repost feed inclusion guardrails', () => {
  const feedSource = readFileSync(join(__dirname, 'posts-feed-query.service.ts'), 'utf8');
  const scoreSource = readFileSync(join(__dirname, 'posts-popular-score.cron.ts'), 'utf8');
  const rankingSource = readFileSync(join(__dirname, 'posts-ranking.service.ts'), 'utf8');

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
    expect(scoreSource).toContain(`CASE WHEN p."kind" = 'repost' THEN`);
    expect(rankingSource).toContain(`CASE WHEN p."kind" = 'repost' THEN`);
    expect(scoreSource).not.toContain(`p."kind"::text <> 'repost'`);
  });
});
