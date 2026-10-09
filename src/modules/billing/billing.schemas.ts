import { z } from 'zod';

export const checkoutSchema = z.object({
  tier: z.enum(['premium', 'premiumPlus']),
});

export const checkoutSyncSchema = z.object({
  sessionId: z.string().min(1),
});

export const setReferralCodeSchema = z.object({
  code: z.string().min(1),
});

export const setRecruiterSchema = z.object({
  code: z.string().min(1),
});

export const appleVerifySchema = z.object({
  signedTransaction: z.string().min(1),
});

export const appleNotificationsSchema = z.object({
  signedPayload: z.string().min(1),
});
