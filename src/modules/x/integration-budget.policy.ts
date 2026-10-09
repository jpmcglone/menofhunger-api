/** Exact USD microdollars. These are ceilings, never spendable cash balances. */
export const INTEGRATION_LIMITS = {
  regular: 8_000_000,
  expensive: 10_000_000,
  analytics: 1_000_000,
  reservePerFundedMember: 2_000_000,
  paidXPublications: 300,
  verifiedXPublications: 50,
} as const;

export type IntegrationBucket =
  | "regular"
  | "expensive"
  | "reserve"
  | "acquisition";
export type IntegrationProvider =
  | "x"
  | "pickax"
  | "linkedin"
  | "youtube"
  | "rumble";
export type CapabilityState =
  | "supported"
  | "unsupported"
  | "awaiting_permission"
  | "temporarily_unavailable"
  | "unknown";

export interface IntegrationEntitlement {
  verified: boolean;
  premium: boolean;
  premiumPlus: boolean;
  banned: boolean;
}

export function integrationLimits(member: IntegrationEntitlement) {
  const eligible = member.verified && !member.banned;
  const paid = member.premium || member.premiumPlus;
  return {
    regular: eligible && paid ? INTEGRATION_LIMITS.regular : 0,
    expensive:
      eligible && member.premiumPlus ? INTEGRATION_LIMITS.expensive : 0,
    analytics: eligible && paid ? INTEGRATION_LIMITS.analytics : 0,
    xPublications: eligible
      ? paid
        ? INTEGRATION_LIMITS.paidXPublications
        : INTEGRATION_LIMITS.verifiedXPublications
      : 0,
  };
}

export function assertMicrodollars(amount: number): void {
  if (!Number.isSafeInteger(amount) || amount < 0)
    throw new Error("Cost must be nonnegative integer microdollars.");
}

export function integrationMonth(now = new Date()): Date {
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
}

export function integrationReset(now = new Date()): string {
  return new Date(
    Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 1),
  ).toISOString();
}

/** Reference prices must be confirmed for the app before a price version is enabled. */
export const X_REFERENCE_PRICES = {
  version: "x-reference-2026-10-01",
  create: 15_000,
  createWithUrl: 200_000,
  userRead: 10_000,
  postRead: 5_000,
  mediaMetadata: 5_000,
  manageContent: 5_000,
} as const;

export interface IntegrationSpendPolicy {
  /** Zero is a kill switch. All limits must come from validated configuration. */
  companyMonthlyMicros: number;
  companyDailyMicros: number;
  providerMonthlyMicros: number;
  /** Funded reserve/acquisition amount, never a count of hypothetical members. */
  sharedMonthlyMicros: number;
  priceVersion: string;
  enabled: boolean;
  removalHeadroomMicros?: number;
  actionLifetimeMicros?: number;
  actionLifetimeRequests?: number;
}
