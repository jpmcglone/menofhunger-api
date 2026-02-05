-- pg_stat_statements: useful “top queries” views.
-- Run with a privileged DB user.

-- Ensure extension exists (may require shared_preload_libraries + restart on managed Postgres).
CREATE EXTENSION IF NOT EXISTS pg_stat_statements;

-- Top by total time (overall load drivers)
SELECT
  queryid,
  calls,
  ROUND(total_exec_time::numeric, 2) AS total_ms,
  ROUND(mean_exec_time::numeric, 2) AS mean_ms,
  ROUND((100.0 * shared_blks_hit / NULLIF(shared_blks_hit + shared_blks_read, 0))::numeric, 2) AS hit_ratio_pct,
  LEFT(REGEXP_REPLACE(query, '\\s+', ' ', 'g'), 240) AS query_sample
FROM pg_stat_statements
WHERE dbid = (SELECT oid FROM pg_database WHERE datname = current_database())
ORDER BY total_exec_time DESC
LIMIT 50;

-- Top by mean time (latency spikes)
SELECT
  queryid,
  calls,
  ROUND(total_exec_time::numeric, 2) AS total_ms,
  ROUND(mean_exec_time::numeric, 2) AS mean_ms,
  LEFT(REGEXP_REPLACE(query, '\\s+', ' ', 'g'), 240) AS query_sample
FROM pg_stat_statements
WHERE dbid = (SELECT oid FROM pg_database WHERE datname = current_database())
  AND calls >= 20
ORDER BY mean_exec_time DESC
LIMIT 50;

-- High call-count queries (chatty paths)
SELECT
  queryid,
  calls,
  ROUND(total_exec_time::numeric, 2) AS total_ms,
  ROUND(mean_exec_time::numeric, 2) AS mean_ms,
  LEFT(REGEXP_REPLACE(query, '\\s+', ' ', 'g'), 240) AS query_sample
FROM pg_stat_statements
WHERE dbid = (SELECT oid FROM pg_database WHERE datname = current_database())
ORDER BY calls DESC
LIMIT 50;

-- Optional: reset stats (use with care)
-- SELECT pg_stat_statements_reset();

