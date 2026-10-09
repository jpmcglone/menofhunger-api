import { cursorPageQuerySchema } from '../../common/pagination/cursor-query.schema';
import { queryBoolean } from '../../common/validation/query-boolean';
import { z } from 'zod';

export const listSchema = cursorPageQuerySchema(100).extend({
  
  q: z.string().optional(),
  showDeleted: queryBoolean().optional(),
  onlyOrphans: queryBoolean().optional(),
  sync: queryBoolean().optional(),
  kind: z.enum(['all', 'image', 'video']).optional(),
});

export const deleteSchema = z.object({
  reason: z.string().trim().min(1).max(200),
  onlyOrphans: z.boolean().optional(),
  referencesToken: z.string().trim().min(1).max(64).optional(),
});

export const bulkDeleteSchema = z.object({
  ids: z.array(z.string().trim().min(1)).min(1).max(200),
  reason: z.string().trim().min(1).max(200),
  onlyOrphans: z.boolean().optional(),
});
