import { readFileSync } from 'node:fs';
import { join } from 'node:path';

describe('repost feed inclusion guardrails', () => {
  const feedSource = readFileSync(join(__dirname, 'posts-feed-query.service.ts'), 'utf8');
  const scoreSource = readFileSync(join(__dirname, 'posts-popular-score.cron.ts'), 'utf8');
  const rankingSource = readFileSync(join(__dirname, 'posts-ranking.service.ts'), 'utf8');

  it('does not globally exclude repost rows from profile or home feeds', () => {
    expect(feedSource).not.toContain("kind: { not: 'repost' }");
    expect(feedSource).not.toContain(`p."kind"::text <> 'repost'`);
  });

  it('scores repost activity so ranked feeds can surface the reposter row', () => {
    expect(feedSource).toContain(`CASE WHEN p."kind" = 'repost' THEN`);
    expect(scoreSource).toContain(`CASE WHEN p."kind" = 'repost' THEN`);
    expect(rankingSource).toContain(`CASE WHEN p."kind" = 'repost' THEN`);
    expect(scoreSource).not.toContain(`p."kind"::text <> 'repost'`);
  });
});
