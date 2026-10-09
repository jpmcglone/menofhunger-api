import { z } from 'zod';

export const searchSchema = z.object({
  q: z.string().trim().max(120).optional(),
  limit: z.coerce.number().int().min(1).max(50).optional(),
});

export const preferenceSchema = z.object({
  termIds: z.array(z.string().trim().min(1)).max(30),
});
