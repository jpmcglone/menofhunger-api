import { ANNOUNCEMENT_MAX_VIEWS_MAX, ANNOUNCEMENT_MAX_VIEWS_MIN } from '../announcements/announcements.selection';
import { z } from 'zod';

export const writeSchema = z.object({
  title: z.string().trim().max(120).optional().nullable(),
  body: z.string().trim().max(2000).optional().nullable(),
  isAd: z.boolean().optional(),
  placement: z.enum(['overlay', 'inline']).optional(),
  ctaLabel: z.string().trim().max(40).optional().nullable(),
  ctaHref: z.string().trim().max(500).optional().nullable(),
  endsAt: z.string().datetime().optional().nullable(),
  imageKey: z.string().trim().max(500).optional().nullable(),
  maxViews: z.number().int().min(ANNOUNCEMENT_MAX_VIEWS_MIN).max(ANNOUNCEMENT_MAX_VIEWS_MAX).optional(),
});
