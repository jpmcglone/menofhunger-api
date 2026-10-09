# Member lifecycle emails

Member event handlers enqueue committed lifecycle changes through `email.lifecycle`.
The reader checks current account state, permission, verified recipient, event age and
email preferences before delivery. Event keys are persisted by the email delivery ledger;
provider retries revisit the reader rather than replaying a stale rendered message.
No existing-member welcome sweep runs at deployment.

| Notice                     | Trigger and audience                                                                                                   | Delivery rule                                                                                                                                                                     |
| -------------------------- | ---------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Verified welcome           | First identity approval, after referral processing completes                                                           | One welcome per person; combines current Premium/referral access. Reverification skips onboarding.                                                                                |
| Premium / Premium+ welcome | Effective tier activates or upgrades through Stripe, production Apple or an active grant                               | Pages and sandbox-only access excluded; renewals do not trigger. Verification/referral operations own their combined welcome.                                                     |
| Referral reward            | Both grants successfully committed                                                                                     | Newly verified recruit receives the combined welcome; inviter receives reward confirmation. Replaces daily signup digest.                                                         |
| Grant expiry               | Active standalone grant has 48–72 hours left                                                                           | Hourly future-only sweep; suppress when subscription or contiguous later grant maintains access. Optional `emailOnboarding` preference.                                           |
| Cancellation confirmation  | Stripe cancellation first becomes scheduled; signed Apple renewal disabled notification                                | Recheck cancellation; show provider access-through date and correct management link.                                                                                              |
| Payment attention          | Confirmed Stripe failed invoice/current past-due state or signed Apple billing retry (verified grace preserves access) | Once per invoice/Apple transaction cycle; suppress when resolved.                                                                                                                 |
| Account changed            | Existing email-changing profile/onboarding mutation commits                                                            | Previous verified address only; never includes new address. New address receives normal verification request. No phone-change endpoint is introduced.                             |
| Verification action        | Pending request committed as rejected                                                                                  | Generic secure next step; never emails rejection reasons/admin notes.                                                                                                             |
| Premium suggestion         | Three days after successful activation welcome                                                                         | Optional `emailOnboarding`; skip when member scheduled a post (including historical published schedule), created a group, or successfully used Marv. No catch-up after four days. |
| Space time change          | Explicitly subscribed event rescheduled                                                                                | Recheck current scheduled time; email new time.                                                                                                                                   |
| Space cancellation / soon  | Existing cancellation or 30-minute reminder                                                                            | Service category preserves optional followed-content preference while bypassing unrelated engagement daily cap. Cancellation snapshots subscribers before schedule clears them.   |

Lifecycle notices have stable event keys, use the verified recipient (except explicitly
snapshotted previous verified account-security address), and reply to
`hello@menofhunger.com`. Optional tips/expiry respect getting-started preferences.
Factual account/membership/payment notices use transactional delivery.

Web subscriptions link to `/settings/billing`. Production Apple subscriptions link to
`https://apps.apple.com/account/subscriptions`. Gift/referral notices do not claim that
an existing paid subscription was cancelled or that future charges cannot occur.
Premium+ copy lists only shipped benefits; planned Steward services stay excluded.

`EMAIL_BILLING_NOTICES_ENABLED` defaults to `true`. Set it to `false` when configured
Stripe/Apple-managed payment notices already cover members, to avoid duplicate payment
attention emails. Provider dashboard settings are not inferred from repository code.
The switch affects payment-attention notices, not membership welcome or cancellation.

Production setup was checked on October 9, 2026: Stripe's card-payment and
bank-debit failure emails were off. The existing billing webhook now includes
`invoice.payment_failed` and `customer.subscription.updated`; its other events,
URL, and API version are preserved. Recheck provider notices before changing
ownership of payment reminders.

Lifecycle/Space side effects retry hourly for up to 23 hours, within the provider key
window. State-invalid or expired events stop; quota/provider failures retry. The durable
ledger records terminal failure reasons. Normal email configuration and scheduler flags
continue to control sending and cron execution.
