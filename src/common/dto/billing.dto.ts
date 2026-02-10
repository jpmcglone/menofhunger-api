export type BillingTier = 'premium' | 'premiumPlus';

export type BillingMeDto = {
  premium: boolean;
  premiumPlus: boolean;
  verified: boolean;
  /** Stripe subscription status (when known). */
  subscriptionStatus: string | null;
  cancelAtPeriodEnd: boolean;
  currentPeriodEnd: string | null;
};

export type BillingCheckoutSessionDto = {
  url: string;
};

export type BillingPortalSessionDto = {
  url: string;
};

