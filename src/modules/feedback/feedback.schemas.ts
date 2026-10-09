import { z } from 'zod';

export const createSchema = z.object({
  category: z.enum(['bug', 'feature', 'account', 'other']),
  email: z.string().trim().email().optional().nullable(),
  subject: z.string().trim().min(1).max(200),
  details: z.string().trim().min(1).max(5000),
});
