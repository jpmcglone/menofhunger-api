import { limitQuery } from '../../common/pagination/cursor-query.schema';
import { z } from 'zod';

export const listSchema = z.object({
  q: z.string().trim().max(200).optional(),
  status: z.enum(['pending', 'dismissed', 'actionTaken']).optional(),
  targetType: z.enum(['post', 'user', 'message', 'article']).optional(),
  reason: z.enum(['spam', 'harassment', 'hate', 'sexual', 'violence', 'illegal', 'other']).optional(),
  limit: limitQuery(100),
  cursor: z.string().optional(),
  sort: z.enum(['newest', 'likely']).optional(),
});

export const updateSchema = z.object({
  status: z.enum(['pending', 'dismissed', 'actionTaken']).optional(),
  adminNote: z.union([z.string().trim().max(2000), z.null()]).optional(),
});
