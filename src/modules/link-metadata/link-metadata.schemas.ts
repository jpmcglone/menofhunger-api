import { z } from 'zod';

export const getSchema = z.object({
  url: z.string().trim().max(2048).url(),
  // Response-shape cache key used by clients when rich metadata fields change.
  v: z.coerce.number().int().positive().optional(),
  purpose: z.enum(["profile"]).optional(),
});
