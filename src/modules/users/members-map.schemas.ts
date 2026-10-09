import { limitQuery } from '../../common/pagination/cursor-query.schema';
import { z } from 'zod';

export const membersQuerySchema = z.object({
  state: z
    .string()
    .trim()
    .regex(/^([A-Za-z]{2}|none)$/, 'State must be a two-letter code or "none".')
    .transform((s) => (s === 'none' ? 'none' : s.toUpperCase())),
  cursor: z.string().trim().regex(/^\d+$/).optional(),
  limit: limitQuery(100),
});
