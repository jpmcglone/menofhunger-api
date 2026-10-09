import { z } from 'zod';

export const connectSchema = z.object({
  clientId: z.string().trim().min(1).max(200),
  clientSecret: z.string().trim().min(1).max(500),
  username: z.string().trim().max(200).optional(),
});
