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


/**
 * Where the user's premium entitlement comes from.
 * - 'stripe' — paid via Stripe (web/desktop checkout)
 * - 'apple'  — paid via Apple IAP (StoreKit 2)
 * - 'grant'  — admin or referral grant
 * - null     — not premium
 *
 * Clients use this to show/hide the correct purchase CTA:
 * iOS should disable the Stripe flow if source == 'stripe', and vice versa on web.
 */
export type BillingSource = 'stripe' | 'apple' | 'grant' | null;

export type BillingMeDto = {
  premium: boolean;
  premiumPlus: boolean;
  verified: boolean;
  /** Where the active premium entitlement originates (see BillingSource). */
  source: BillingSource;
  /** Stripe subscription status (when known). */
  subscriptionStatus: string | null;
  cancelAtPeriodEnd: boolean;
  /** When the current Stripe billing period ends (null if no active Stripe sub). */
  currentPeriodEnd: string | null;
  /** Apple IAP subscription expiry (null if no active Apple sub). */
  appleExpiresAt: string | null;
  /** Latest access expiry across Stripe + Apple + active grants. */
  effectiveExpiresAt: string | null;
  /** Active (non-expired, non-revoked) subscription grants. */
  grants: ActiveSubscriptionGrantDto[];
  /** Referral code set by this user (premium-only). */
  referralCode: string | null;
  /** Who recruited this user (null if no recruiter). */
  recruiter: {
    id: string;
    username: string | null;
    name: string | null;
    avatarUrl: string | null;
    premium: boolean;
    premiumPlus: boolean;
    verifiedStatus: 'none' | 'identity' | 'manual';
  } | null;
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
