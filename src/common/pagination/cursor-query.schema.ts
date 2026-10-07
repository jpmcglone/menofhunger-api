import { z } from 'zod';

/** Optional page size from a query string, coerced to an integer in `[1, max]`. */
export function limitQuery(max: number) {
  return z.coerce.number().int().min(1).max(max).optional();
}

/** `?limit=&cursor=` for cursor-paginated list endpoints. */
export function cursorPageQuerySchema(maxLimit = 50) {
  return z.object({
    limit: limitQuery(maxLimit),
    cursor: z.string().optional(),
  });
}
