import { z } from 'zod';

export const briefBodySchema = z.object({
  range: z.enum(['7d', '30d', '3m', '1y', 'all']),
  analytics: z.record(z.string(), z.unknown()),
  referrals: z.record(z.string(), z.unknown()).nullable().optional(),
});
