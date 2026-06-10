export type AffiliateEarningType = 'signup' | 'verified' | 'premium' | 'premium60d';

export type AffiliateEarningDto = {
  id: string;
  recruitUserId: string;
  recruitUsername: string | null;
  recruitName: string | null;
  type: AffiliateEarningType;
  /** Amount in cents (USD). */
  amountCents: number;
  createdAt: string;
  settledAt: string | null;
};

export type AffiliateSummaryDto =
  | {
      isAffiliate: false;
    }
  | {
      isAffiliate: true;
      pendingCents: number;
      settledCents: number;
      /** Total lifetime earnings (pending + settled). */
      totalCents: number;
      /** Minimum pending balance required to trigger a payout. */
      minPayoutCents: number;
      /** Per-member lifetime earnings cap. */
      capCents: number;
      /** True when totalCents >= capCents. */
      capReached: boolean;
      counts: {
        signups: number;
        verified: number;
        premium: number;
        premium60d: number;
      };
      earnings: AffiliateEarningDto[];
    };

export type AdminAffiliateUserDto = {
  userId: string;
  username: string | null;
  name: string | null;
  affiliateAt: string;
  recruitCount: number;
  pendingCents: number;
  settledCents: number;
  /** Total lifetime earnings (pending + settled). */
  totalCents: number;
  /** Per-member lifetime earnings cap. */
  capCents: number;
  /** True when totalCents >= capCents. */
  capReached: boolean;
};

export type AdminAffiliateSettleDto = {
  settledCount: number;
  settledCents: number;
};
