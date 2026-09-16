import type { BillingMeDto } from './billing.dto';
import type { AccountDeletionRequestDto } from './account-deletion.dto';
import type { MarvinMeDto } from './marvin/marvin-me.dto';

// Synthetic, API-owned wire examples. Both clients consume generated copies.
// Keep dates fixed so fixtures and cross-platform checks are reproducible.
const emptyBilling: BillingMeDto = {
  premium: false, premiumPlus: false, verified: false, source: null,
  subscriptionStatus: null, cancelAtPeriodEnd: false, currentPeriodEnd: null,
  appleExpiresAt: null, effectiveExpiresAt: null, grants: [], referralCode: null,
  recruiter: null, recruitCount: 0, referralBonusGranted: false, recruitBonusEligible: false,
};
const expiry = '2030-10-16T00:00:00.000Z';
export const contractFixtures = {
  billing: {
    unverified: emptyBilling,
    verified: { ...emptyBilling, verified: true },
    apple: { ...emptyBilling, verified: true, premium: true, source: 'apple', appleExpiresAt: expiry, effectiveExpiresAt: expiry },
    stripe: { ...emptyBilling, verified: true, premium: true, premiumPlus: true, source: 'stripe', subscriptionStatus: 'active', currentPeriodEnd: expiry, effectiveExpiresAt: expiry },
    cancelled: { ...emptyBilling, verified: true, premium: true, source: 'stripe', subscriptionStatus: 'active', cancelAtPeriodEnd: true, currentPeriodEnd: expiry, effectiveExpiresAt: expiry },
    expired: { ...emptyBilling, verified: true },
    grant: { ...emptyBilling, verified: true, premium: true, source: 'grant', effectiveExpiresAt: expiry, grants: [{ id: 'synthetic-grant', tier: 'premium', source: 'admin', months: 1, startsAt: '2030-09-16T00:00:00.000Z', endsAt: expiry, reason: null }] },
  } satisfies Record<string, BillingMeDto>,
  marvin: {
    enabled: true, isPremium: true, preferredMode: 'auto', aiConsentGranted: false,
    credits: { credits: 10, maxCredits: 100, creditsPerDay: 10, lastRefilledAt: '2030-09-16T00:00:00Z' },
    costs: { fast: 1, regular: 2, smart: 4, webSearchSurcharge: 1, visionPerImage: 1, urlFetchSurcharge: 1 },
    marv: null,
  } satisfies MarvinMeDto,
  deletion: {
    success: true, deletionScheduledAt: '2030-10-16T00:00:00Z',
    deletionStatusToken: '11111111-1111-4111-8111-111111111111',
  } satisfies AccountDeletionRequestDto,
};
