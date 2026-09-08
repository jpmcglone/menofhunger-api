# For You ranking

For You combines recent unseen followed posts, friend engagement, second-degree
connections, trending posts, and a separate chronological lane. Trending
cannot consume the chronological lane's budget. All lanes apply the same visibility,
block, ban, and group filters before ranking.

## Request cost and refresh

- Page one scans at most 120 discovery rows total (80 trending, 40 chronological),
  80 followed rows, one page of friend-engaged posts, and half a page of second-degree
  posts. Each lane reads one extra row to detect overflow.
- Deeper scans are capped at 240 rows per lane (120 chronological). Second-degree edges are capped at
  300 on page one and 1,000 deeper. Graph and recent engagement-author inputs are
  cached for 15 seconds, including on explicit refresh; candidates and permissions
  are read again.
- Friend proof aggregates in PostgreSQL over candidate IDs and followed actors,
  returning one row per candidate. One person counts once across boosts, replies,
  and reposts; at most ten people contribute to the social-proof base score.
- Normal first-page responses retain their existing 15-second result cache and
  stampede protection. Explicit refresh bypasses that cache and creates a new seed.
- Refresh preserves the fresh-follow quota, then reserves up to 20% of the page for
  seeded discovery, preferring unseen candidates. Remaining slots use relevance,
  seen penalties, recency, author diversity, and saturation-aware jitter. This can
  change page membership even when multiplying scores by jitter would not.
- Both clients already flush pending view reports before refresh. Viewing content
  affects the next ranking; merely receiving it does not mark it read.

## Pagination

V4 cursors reference immutable Redis records containing all IDs served so far,
ranking seed, and viewer identity. Each cursor is small, bound to its viewer, and
can be retried without advancing another tab's pagination. Records expire after an
hour. An expired session asks the viewer to refresh instead of silently restarting
and returning duplicates.

Sessions end after 2,000 raw posts to bound Redis storage and SQL exclusions. Refresh
starts a new session. During a Redis write outage, inline cursors retain at most 100 IDs; a page that exceeds that limit ends safely. Legacy v2/v3 cursors remain readable; their history is
never truncated again. Missing server history cannot be reconstructed and requires
refresh.

## Shared trending score

`postRankingSql` is used by both scheduled and immediate score updates. It includes
boosts, bookmarks, replies, reposts/quotes, polls, hashtags, check-in substance, and
pins. Content/author/ancestor multipliers and the capped engagement-rate bonus apply
to the complete additive score. Zero scores clear previous stored scores.

Persisted scores are per-post: the same inputs score identically alone or in a
batch. Author diversity is enforced when assembling the feed, rather than applying
a different author penalty only during scheduled scoring. For You adds a base of
one to nonnegative trending scores, so gaining positive engagement cannot reduce
that base.

## Focused validation

```sh
npm test -- --runInBand --runTestsByPath src/modules/posts/posts.service.spec.ts --testNamePattern PostsService.listForYouFeed
RUN_POST_RANKING_SQL_TESTS=1 npm test -- --runInBand --runTestsByPath src/modules/posts/posts-ranking.postgres.spec.ts
```

The opt-in SQL suite requires PostgreSQL binaries on PATH and creates/stops a
fresh temporary cluster using a private Unix socket with TCP disabled. It never
connects to the application database. It exercises the actual SQL for score
multipliers, batch equivalence, repost contributions, zero scores, and unique
friend proof.

For an existing external PGlite installation, set `POST_RANKING_PGLITE_MODULE` to
its absolute module path and launch Jest with Node's `--experimental-vm-modules`
flag. This executes the same tests on WASM PostgreSQL without a server or changes
to application dependencies:

```sh
RUN_POST_RANKING_SQL_TESTS=1 POST_RANKING_PGLITE_MODULE=/absolute/path/to/pglite node --experimental-vm-modules node_modules/jest/bin/jest.js --runInBand --runTestsByPath src/modules/posts/posts-ranking.postgres.spec.ts
```
