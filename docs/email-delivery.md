# Email delivery

Every logical event uses `EmailService.sendText`/`sendEmail` with a stable `eventKey`.
The database uniquely claims that event, stores the accepted Resend message ID,
and sends a stable `Idempotency-Key` on all attempts. Resend keys expire after
24 hours, so MOH stops every retry after 23 hours. Provider failures retry at most
six times with backoff; quota delays do not spend the provider retry allowance.
Daily slots and optional per-user caps are reserved atomically in Redis. The same
logical event retains its slot through ambiguous provider responses; confirmed
rejections release it. Redis failure defers delivery instead of bypassing the quota.

Categories:

- `transactional`: account/security/billing facts; uses the reserved daily budget.
- `service`: requested event changes, invitations, messages; bypasses the optional
  per-user daily cap, while preserving the account reserve and family preference.
- `engagement`: optional reminders; daily per-user cap and engagement budget.
- `broadcast`: newsletter budget and newsletter consent.

Optional sends pass `userId` and an existing `EmailPreference`. This adds a visible
family unsubscribe link and RFC 8058 one-click headers. GET only opens confirmation;
POST verifies the signed token and turns off that family. Links for a replaced
email address become invalid. Legacy newsletter unsubscribe tokens still work.

Retries recheck suppression, current verified address, active account, and optional
preferences. Permission-sensitive messages never automatically replay a saved
payload. Set `retrySafe: false` and retry the owning event handler so it can recheck
current access/state. An account-address-change notice may use `recipientMode:
'previous'` with a transactional category. Email-address confirmation uses
`recipientMode: 'verification'` and never automatically replays an expiring link.

Payloads are erased on terminal delivery/failure or retry expiry. Embedded image
URLs are retained independently and registered with admin media review, so sent
email photos cannot be deleted as orphans. User deletion cascades private ledger
records. Suppression retains only a stable normalized address hash and reason, so authentication secret rotation preserves bounces/complaints.

## Provider configuration

Apply the committed email delivery migration before enabling these send paths.
No migration is automatically applied by tests.

Set `RESEND_WEBHOOK_SECRET` to the signing secret from Resend and register the public
endpoint `POST /v1/email/webhook/resend` for `email.delivered`, `email.bounced`, and
`email.complained`. MOH verifies exact raw bytes, the Svix HMAC signature, and a
five-minute timestamp tolerance. Delivery events are transactional and deduplicated
by Svix ID. Both the send result and committed webhook reconcile receipts by message
ID, including events that arrive before the ID is saved. Conditional updates preserve
complaints and bounces when delayed receipts overlap. Final bounces and complaints
suppress all categories immediately.
An unset signing secret rejects webhook calls; there is no unsigned fallback.

Set `EMAIL_PUBLIC_API_URL` when the API uses a custom public origin/version prefix.
Default: `https://api.menofhunger.com/v1` in production and
`http://localhost:3001/v1` in development. This generates email unsubscribe links.

References: [Resend send and idempotency API](https://resend.com/docs/api-reference/emails/send-email),
[Resend webhook verification](https://resend.com/docs/webhooks/verify-webhooks-requests),
[Svix manual verification protocol](https://docs.svix.com/receiving/verifying-payloads/how-manual).

## Local validation

`node scripts/check-email-budget.cjs` runs a bounded concurrency test against
localhost Redis using an isolated random prefix, deletes its keys, and leaves
application keys untouched. Unit tests mock the provider; no email is sent.
