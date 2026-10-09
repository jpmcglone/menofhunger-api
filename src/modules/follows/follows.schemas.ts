import { cursorPageQuerySchema } from '../../common/pagination/cursor-query.schema';
import { z } from 'zod';

export const listSchema = cursorPageQuerySchema();

export const recommendationsSchema = z.object({
  limit: z.coerce.number().int().min(1).max(50).optional(),
  /** Comma-separated interest keys; when present, returns users sorted by overlap count. */
  interests: z.string().optional(),
  seed: z.string().trim().min(1).max(80).optional(),
});

export const topUsersSchema = z.object({
  limit: z.coerce.number().int().min(1).max(50).optional(),
});

export const postNotificationsSchema = z.object({
  enabled: z.boolean().optional(),
  preference: z.enum(['all', 'posts', 'off']).optional(),
}).refine(body => (body.enabled !== undefined) !== (body.preference !== undefined), { message: 'Choose one notification preference.' });
