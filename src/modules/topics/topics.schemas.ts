import { cursorPageQuerySchema } from '../../common/pagination/cursor-query.schema';
import { z } from 'zod';

export const listTopicsSchema = z.object({
  limit: z.coerce.number().int().min(1).max(50).optional(),
});

export const listTopicPostsSchema = cursorPageQuerySchema();

export const listFollowedSchema = z.object({
  limit: z.coerce.number().int().min(1).max(50).optional(),
});

export const listCategoriesSchema = z.object({
  limit: z.coerce.number().int().min(1).max(50).optional(),
});
