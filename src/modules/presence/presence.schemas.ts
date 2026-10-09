import { cursorPageQuerySchema } from '../../common/pagination/cursor-query.schema';
import { z } from 'zod';

export const recentSchema = cursorPageQuerySchema();

export const onlinePageSchema = z.object({
  includeSelf: z.string().optional(),
  recentLimit: z.coerce.number().int().min(1).max(50).optional(),
  recentCursor: z.string().optional(),
});

export const STATUS_DURATION_HOURS = [1, 3, 6, 12, 24] as const;

export const statusBodySchema = z.object({
  text: z.string().trim().min(1).max(120),
  durationHours: z
    .union(STATUS_DURATION_HOURS.map((h) => z.literal(h)) as [z.ZodLiteral<1>, z.ZodLiteral<3>, z.ZodLiteral<6>, z.ZodLiteral<12>, z.ZodLiteral<24>])
    .default(24),
  createsPost: z.boolean().default(true),
});

export const editStatusBodySchema = z.object({
  text: z.string().trim().min(1).max(120),
});
