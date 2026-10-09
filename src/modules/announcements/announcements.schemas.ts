import { z } from 'zod';

export const platformSchema = z.enum(['web', 'ios']);

export const anonymousIdSchema = z.string().trim().min(12).max(128).optional();

export const pendingQuerySchema = z.object({
  platform: platformSchema,
  anonymousId: anonymousIdSchema,
});

export const eventBodySchema = z.object({
  type: z.enum(['presented', 'viewed', 'dismissed', 'clicked', 'abandoned']),
  platform: platformSchema,
  anonymousId: anonymousIdSchema,
  dismissMethod: z.enum(['close_button', 'backdrop', 'escape', 'swipe']).optional().nullable(),
});
