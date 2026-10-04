# Delegated work follow-through

Design: [existing native and desktop delegated-work screens](https://www.figma.com/design/YnuRSJB7p90n9jEY4mb4RN?node-id=221-2).

## Configuration and deployment

Apply the additive `20261004010000_delegation_follow_through` migration through the normal API deployment. It adds saved baselines, temporary resume times, notification delivery state, exact-subject uniqueness, and optional notification action paths. Deploy API before clients. Old schedules retain their existing defaults. No existing job receives automatic publishing permission.

Optional GitHub: set `MARV_GITHUB_REPOSITORY=owner/repository` and `MARV_GITHUB_TOKEN` through server deployment settings. Use a fine-grained token restricted to Issues read/write on that repository. Tokens never enter tool results, proposals or logs. Issue creation includes reviewed text and a feedback backlink; repository changes invalidate reviewed snapshots. A transport timeout is uncertain and must not be retried. `read_admin` can inspect the latest ten linked issues for closure without changing feedback status. Other external destinations remain downloadable exports.

## Semantics

- Once without `at` runs now. Daily/weekly may select weekdays. Monthly defaults to day 1; months without the chosen date are skipped. DST gaps skip; repeated local minutes run once. `endsAt` is an absolute final instant.
- Conditions are evaluated deterministically before AI work. A matching prior successful/review run suppresses another run within the cooldown. A skipped condition records a receipt and remains quiet.
- Baselines retain the first evidence snapshot and original revision. Recent runs provide comparisons. Cohort previews remain bounded and are labeled; counts are population totals. Outcomes are observational, never causal attribution.
- Replies to the same parent and GitHub issues for the same feedback have persistent unique subject keys. Cancelled/rejected proposals release their key; completed and uncertain actions retain it.
- Result notifications are queued through SideEffectsService and recovered by the scheduler. Admin access is rechecked before delivery. Off stays quiet. Actionable sends review/failure/uncertainty, all also sends completion, digest batches at 09:00 Eastern. Notification previews contain no sensitive operational details.
- Removing a connector does not cancel durable jobs. Pause or cancel them explicitly.

See [generated capabilities](mcp-capabilities.md) for each transport and reviewed workflow operation.
