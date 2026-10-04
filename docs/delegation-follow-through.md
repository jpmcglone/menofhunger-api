# Delegated work follow-through

Design: [existing native and desktop delegated-work screens](https://www.figma.com/design/YnuRSJB7p90n9jEY4mb4RN?node-id=221-2).

## Configuration and deployment

Apply the additive `20261004010000_delegation_follow_through` migration through the normal API deployment. It adds saved baselines, temporary resume times, notification delivery state, exact-subject uniqueness, and optional notification action paths. Deploy API before clients. Old schedules retain their existing defaults. No existing job receives automatic publishing permission.

Issue tracking uses Linear. MARV can prepare markdown issue exports; no direct issue-creation connection is configured. GitHub issue creation has been removed. Existing receipts remain history, but no new GitHub action can be prepared or confirmed.

## Semantics

- Once without `at` runs now. Daily/weekly may select weekdays. Monthly defaults to day 1; months without the chosen date are skipped. DST gaps skip; repeated local minutes run once. `endsAt` is an absolute final instant.
- Conditions are evaluated deterministically before AI work. A matching prior successful/review run suppresses another run within the cooldown. A skipped condition records a receipt and remains quiet.
- Baselines retain the first evidence snapshot and original revision. Recent runs provide comparisons. Cohort previews remain bounded and are labeled; counts are population totals. Outcomes are observational, never causal attribution.
- Replies to the same parent have persistent unique subject keys. Cancelled/rejected proposals release their key; completed and uncertain actions retain it.
- Result notifications are queued through SideEffectsService and recovered by the scheduler. Admin access and the current job revision are rechecked before delivery. Runs without an explicit notification setting in their creation snapshot are silent, including all historical runs from before the notification rollout. Editing a job never retroactively enables notifications for earlier runs. Cancelled or superseded runs remain quiet. Off stays quiet. Actionable sends review/failure/uncertainty, all also sends completion, digest batches at 09:00 Eastern. Notification previews contain no sensitive operational details.
- Removing a connector does not cancel durable jobs. Pause or cancel them explicitly.

See [generated capabilities](mcp-capabilities.md) for each transport and reviewed workflow operation.

## Notification rollout correction

`20261004173000_delegation_notification_opt_in` retires undelivered legacy run notifications and cancels only unexecuted GitHub proposals. It does not delete existing notifications, job history, or completed/uncertain receipts. The initial notification migration did not distinguish old runs from new deliveries, so the recovery sweep replayed old failed/review states. Delivery now requires explicit notification settings in the run's original snapshot, not just the current job.

Existing clients retain read-only historical receipt links. GitHub creation is absent from the server schema and tools and cannot execute, even when an old proposal is submitted. Linear is the issue-tracking destination; direct server integration is not configured.
