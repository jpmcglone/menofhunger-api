import { z } from 'zod';

export const searchSchema = z.object({
  q: z.string().trim().min(1).max(120),
  limit: z.coerce.number().int().min(1).max(50).optional(),
});

export const trendingSchema = z.object({
  limit: z.coerce.number().int().min(1).max(50).optional(),
});
