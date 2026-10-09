import { z } from 'zod';

export const markViewedBatchSchema = z.object({
  articleIds: z.array(z.string().trim().min(1)).min(1).max(50),
  require_auth: z.boolean().optional(),
  anon_id: z.string().trim().min(12).max(128).optional(),
  source: z.string().trim().min(1).max(80).optional(),
});
