import { z } from 'zod';

export const acquisitionQuerySchema = z.object({
  days: z.coerce.number().int().min(1).max(90).default(7),
});

export const newMemberPostsQuerySchema = z.object({
  newMembersDays: z.coerce.number().int().min(1).max(30).default(7),
  minAgeMinutes: z.coerce.number().int().min(0).max(7 * 24 * 60).default(60),
  limit: z.coerce.number().int().min(1).max(50).default(25),
});
