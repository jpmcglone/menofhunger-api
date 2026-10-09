import { z } from 'zod';

export const adminUserPatchSchema = z.object({
  credits: z.number().min(0).max(1_000_000).optional(),
  disabled: z.boolean().optional(),
});
