import { queryBoolean } from '../../common/validation/query-boolean';
import { z } from 'zod';

export const listSchema = z.object({
  q: z.string().trim().max(200).optional(),
  limit: z.coerce.number().int().min(1).max(100).optional(),
  offset: z.coerce.number().int().min(0).max(10_000).optional(),
  includeDisbanded: queryBoolean().optional(),
});

export const transferSchema = z.object({
  newOwnerUserId: z.string().trim().min(1),
});
