import { z } from 'zod';

export const deleteAccountSchema = z.object({
  reason: z.string().max(100).optional().nullable(),
  details: z.string().max(2000).optional().nullable(),
});
