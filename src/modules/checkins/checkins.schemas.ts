import { z } from 'zod';

export const createSchema = z.object({
  body: z.string().trim().min(1).max(1000),
  visibility: z.enum(['verifiedOnly', 'premiumOnly']),
  /** Reject stale answers when the displayed prompt no longer matches today's prompt. */
  prompt: z.string().trim().min(1).max(500).optional(),
});

export const leaderboardQuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(50).optional(),
  scope: z.enum(['weekly', 'best']).optional(),
});
