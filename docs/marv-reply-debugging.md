# Debugging a missing Marv reply

Start with the API, not the typing animation. Typing means a worker started processing;
it does not mean a reply was saved. Catch-up uses a separate delivery path and can work
while post/chat delivery fails.

## Read production diagnostics

From the API checkout, using your existing administrator CLI login:

```sh
npm run --silent moh -- --env prod queues --json
npm run --silent moh -- --env prod workspace --workspace marv_usage --limit 25 --json
```

Use `--env local` for the local API. If login is required, run `npm run moh -- login`
in your terminal; never paste credentials or an OTP into a support conversation.
These commands read data. They do not send a message, retry a job, or spend credits.
The Jobs page (`/admin/jobs`) also reports queue health.

A healthy empty queue does **not** prove successful delivery. Handled failures can finish
a queue job after refunding credits. Check the usage record's `errorCode` and `routingReason`.

| Evidence | Next check |
| --- | --- |
| No usage event, waiting jobs, zero workers | Confirm the API/worker is running with job consumers enabled. |
| No usage event and no queued job | Search API logs for `dm-enqueue` or the triggering post ID. Check eligibility and queue handoff. |
| `ai_not_configured` | Check the deployed AI configuration through the normal secret-management workflow. |
| `ai_error`, `generation:upstream_429`, or `generation:timeout` | Inspect the provider/network failure. AI response requests share a 210-second deadline across rounds/retries. |
| `post_failed` or `message_failed`, with a response ID | Generation finished; saving/delivery failed. Inspect the safe delivery reason. |
| `delivery:ai_consent_required` | Legacy clients only. Current Marv use records personal-request permission automatically. |
| `delivery:post_too_long_500` / `post_too_long_1000` | A writer used the wrong body limit. Bot replies are bounded to 1,000 characters. |
| `delivery:group_membership_required`, `premium_required`, or `blocked` | Access changed before delivery; do not bypass it. |
| `delivery:database_P2022` | Deployed Prisma client and database schema differ; inspect migration status against the intended environment. |
| `delivery:delivery_refused` | The direct-message path returned no message, for example because access was blocked. |
| No error, saved reply ID in logs | Inspect the client websocket event/cache path and refresh the thread. |

## Find logs

In Render, open the API/worker service's **Logs** and search for `[marv]`, then narrow to
`sourceId=<post-or-conversation-id>`. Locally, use the terminal running the API process.
The completion record includes source, source ID, root post ID, OpenAI response ID, model,
latency, credits charged, safe reason, and outcome. Failures use warning severity.
Provider response IDs are correlation metadata; new diagnostic reasons never copy prompts,
message bodies, credentials, SQL, or arbitrary exception text.

## September 16, 2026 finding and fix

Production usage showed generated replies followed by `message_failed` and `post_failed`,
while catch-up succeeded and queue workers were healthy. The DM writer required AI consent
from Marv's own account. The post writer also applied a normal member's billing, character,
rate-limit and group-membership rules to the bot; production Marv had no paid entitlement.
The old public failure record does not identify which specific validation rejected that reply.

The fix keeps consent on human requests and gives internal Marv replies a constrained writer:
only the configured bot, replying to the requesting member's post, using that member's current
thread/group permissions, retaining blocks, moderation, private-post exclusion and audience
inheritance. It does not grant Marv a subscription. Overlong generated replies are bounded;
failed delivery is refunded and no longer becomes the next chat response-chain checkpoint.
Transient generation failures get the existing rate-limited failure reply.

After deployment, manually send one DM and one mention from a consenting, verified Premium
test account. Confirm a saved response, stopped typing, successful usage event, and one credit
charge. Test a group/restricted thread within its audience. Use disposable test accounts for
block/access failure checks. No production messages were sent as part of this investigation.
