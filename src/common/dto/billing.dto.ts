export type BillingTier = 'premium' | 'premiumPlus';
export type SubscriptionGrantSource = 'admin' | 'referral';

export type ActiveSubscriptionGrantDto = {
  id: string;
  tier: BillingTier;
  source: SubscriptionGrantSource;
  months: number;
  startsAt: string;
  endsAt: string;
  reason: string | null;
};


export type BillingMeDto = {
  premium: boolean;
  premiumPlus: boolean;
  verified: boolean;
  /** Stripe subscription status (when known). */
  subscriptionStatus: string | null;
  cancelAtPeriodEnd: boolean;
  /** When the current Stripe billing period ends (null if no active Stripe sub). */
  currentPeriodEnd: string | null;
  /** Latest access expiry across Stripe + active grants. */
  effectiveExpiresAt: string | null;
  /** Active (non-expired, non-revoked) subscription grants. */
  grants: ActiveSubscriptionGrantDto[];
  /** Referral code set by this user (premium-only). */
  referralCode: string | null;
  /** Who recruited this user (null if no recruiter). */
  recruiter: { username: string | null; name: string | null } | null;
  /** How many users this user has recruited. */
  recruitCount: number;
  /** Whether the one-time referral bonus has been granted to this user. */
  referralBonusGranted: boolean;
};

export type BillingCheckoutSessionDto = {
  url: string;
};

export type BillingPortalSessionDto = {
  url: string;
};

/** Summary of banked free months for admin grant management UI. */
export type AdminGrantSummaryDto = {
  premiumMonthsRemaining: number;
  premiumPlusMonthsRemaining: number;
};
