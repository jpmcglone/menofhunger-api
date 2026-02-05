## pg_stat_statements quickstart (Men of Hunger)

This project’s biggest wins (indexes, trending precompute, search FTS) should be validated with **before/after** query timing.

`pg_stat_statements` is the simplest way to do that in Postgres.

### 1) Enable (production note)

`pg_stat_statements` typically requires:

- `shared_preload_libraries = 'pg_stat_statements'` (DB setting)
- a DB restart
- `CREATE EXTENSION IF NOT EXISTS pg_stat_statements;` (SQL)

On managed Postgres (e.g. Render), enabling preload libraries may be done in the provider UI rather than SQL.

### 2) What to capture before/after changes

Run the queries in [`pg_stat_statements.sql`](./pg_stat_statements.sql) and save:

- Top queries by **total_time**
- Top queries by **mean_time**
- Top queries by **p95** if your provider exposes it (many don’t)

Then correlate `query` text with code paths:

- Trending feed: `PostsService.listPopularFeed()` in `src/modules/posts/posts.service.ts`
- Search: `SearchService.searchPosts()` in `src/modules/search/search.service.ts`
- Follow recommendations: `FollowsService.recommendUsersToFollow()`
- Notifications list: `NotificationsService.list()`

### 3) Explain the worst offenders

For each slow query (or representative sample), run:

- `EXPLAIN (ANALYZE, BUFFERS, VERBOSE) <query>;`

and confirm whether the planner is using:

- the intended index(es)
- bitmap index scans vs sequential scans
- reasonable row estimates (big misestimates often mean missing stats or bad selectivity)

### 4) Reset stats (optional)

If you want a clean “measurement window”:

- `SELECT pg_stat_statements_reset();`

