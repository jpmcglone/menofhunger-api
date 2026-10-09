import { z } from 'zod';

export const setAffiliateSchema = z.object({
  enabled: z.boolean(),
});
