/** Stable access-source identity; renewals never emit unless the effective tier actually changes. */
export function lifecycleTierEventId(input: {
  source: "stripe" | "apple" | "grant" | "referral";
  tier: "premium" | "premiumPlus";
  stripeSubscriptionId?: string | null;
  stripeCurrentPeriodStart?: Date | null;
  appleOriginalTransactionId?: string | null;
  appleExpiresAt?: Date | null;
  grantId?: string | null;
}): string | null {
  if (input.source === "stripe")
    return input.stripeSubscriptionId
      ? `${input.stripeSubscriptionId}-${input.stripeCurrentPeriodStart?.toISOString() ?? "active"}-${input.tier}`
      : null;
  if (input.source === "apple")
    return input.appleOriginalTransactionId && input.appleExpiresAt
      ? `${input.appleOriginalTransactionId}-${input.appleExpiresAt.toISOString()}-${input.tier}`
      : null;
  return input.grantId ?? null;
}
