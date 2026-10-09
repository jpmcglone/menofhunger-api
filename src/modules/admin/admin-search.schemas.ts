import { limitQuery } from '../../common/pagination/cursor-query.schema';
import { z } from 'zod';

export const listSchema = z.object({
  q: z.string().trim().max(200).optional(),
  limit: limitQuery(100),
  cursor: z.string().optional(),
});
