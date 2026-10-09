import { z } from 'zod';

export const startSchema = z.object({
  username: z.string().min(1).max(64),
});
