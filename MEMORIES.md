# Bug Memory

Tracks bugs reported by the automated bug-finding scan. Only open or rejected PRs with dates.

| Description | Repo | PR | Status | Date |
|-------------|------|----|--------|------|
| `useWebsters1828Wotd` getCachedData never returns undefined on refresh — WOTD stays stale all session | menofhunger-www | https://github.com/jpmcglone/menofhunger-www/pull/new/fix/wotd-refresh-blocking-cache (branch ready, PR not yet opened via UI) | open | 2026-08-03 |
| Quote/gated content leak via quotedPost DTO — toPostDto calls toPostDto(rawQuotedPost) with no viewer gate; create-time floor skipped for replies/group posts | menofhunger-api | (local WIP in progress — posts-quote-leak.spec.ts + quotedPostMap feed path) | wip-no-pr | 2026-08-03 |
