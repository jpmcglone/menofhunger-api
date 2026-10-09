import { z } from 'zod';

export const updateSchema = z.object({
  postsPerWindow: z.coerce.number().int().min(1).max(100).optional(),
  windowSeconds: z.coerce.number().int().min(10).max(24 * 60 * 60).optional(),
  verifiedPostsPerWindow: z.coerce.number().int().min(1).max(100).optional(),
  verifiedWindowSeconds: z.coerce.number().int().min(10).max(24 * 60 * 60).optional(),
  premiumPostsPerWindow: z.coerce.number().int().min(1).max(100).optional(),
  premiumWindowSeconds: z.coerce.number().int().min(10).max(24 * 60 * 60).optional(),
  autoVerifyNewUsers: z.boolean().optional(),
  /** Literal referral code to scope auto-verify; null/empty clears the filter. */
  autoVerifyReferralCode: z.union([z.string().trim().max(50), z.null()]).optional(),
});

export const previewSchema = z.object({
  referralCode: z.string().trim().min(1).max(50),
});

export const applySchema = z.object({
  recruiterId: z.string().trim().min(1),
});
