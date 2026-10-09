/** Cash rates in cents per recruit milestone. */
export const AFFILIATE_RATES_CENTS = {
  signup: 100,
  verified: 300,
  premium: 1000,
  premium60d: 1000,
} as const;

/** Minimum pending balance required for admin to settle a payout. */
export const AFFILIATE_MIN_PAYOUT_CENTS = 5_000; // $50

/** Per-member lifetime earnings cap. Stops new accrual once reached. */
export const AFFILIATE_CAP_CENTS = 100_000; // $1,000

/** Days after first premium payment before the retention milestone fires. */
export const AFFILIATE_PREMIUM_RETENTION_DAYS = 60;
