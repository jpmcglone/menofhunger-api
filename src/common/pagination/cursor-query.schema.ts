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

/** Like `cursorPageQuerySchema`, but `limit` always resolves (to `defaultLimit`) and the cursor length is bounded. */
export function defaultedCursorPageQuerySchema(opts: { maxLimit: number; defaultLimit: number; maxCursorLength: number }) {
  return z.object({
    limit: z.coerce.number().int().min(1).max(opts.maxLimit).default(opts.defaultLimit),
    cursor: z.string().max(opts.maxCursorLength).optional(),
  });
}
