import { limitQuery } from '../../common/pagination/cursor-query.schema';
import { z } from 'zod';

export const listSchema = z.object({
  feedbackId: z
    .string()
    .regex(/^[A-Za-z0-9_-]{1,64}$/)
    .optional(),
  q: z.string().trim().max(200).optional(),
  status: z.enum(["new", "triaged", "resolved"]).optional(),
  category: z.enum(["bug", "feature", "account", "other"]).optional(),
  limit: limitQuery(100),
  cursor: z.string().optional(),
});

export const updateSchema = z.object({
  status: z.enum(["new", "triaged", "resolved"]).optional(),
  adminNote: z.union([z.string().trim().max(2000), z.null()]).optional(),
});
