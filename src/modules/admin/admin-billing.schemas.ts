import { z } from 'zod';

export const setGrantsSchema = z.object({
  premiumMonths: z.number().int().min(0).max(1200).optional(),
  premiumPlusMonths: z.number().int().min(0).max(1200).optional(),
});
