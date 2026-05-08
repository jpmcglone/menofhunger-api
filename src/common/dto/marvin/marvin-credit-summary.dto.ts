/**
 * Snapshot of the requester's Marv credit bucket. Returned by `GET /marvin/me` and emitted
 * via the `marv:credits-updated` realtime event after any reply (or refill).
 */
export type MarvinCreditSummaryDto = {
  /** Current balance after lazy refill. May be fractional during partial accrual. */
  credits: number;
  /** Maximum bucket size — credits accrue up to this cap then stop. */
  maxCredits: number;
  /** Refill rate in credits per 24 hours. */
  creditsPerDay: number;
  /** ISO timestamp of the last balance write (used to compute next refill). */
  lastRefilledAt: string;
};
