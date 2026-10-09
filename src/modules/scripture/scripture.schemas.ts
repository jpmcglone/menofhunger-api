import { z } from 'zod';

export const getSchema = z.object({
  ref: z.string().trim().min(1),
});
