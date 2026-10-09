import { newsletterAudienceFiltersSchema } from '../newsletters/newsletter-audience';
import { z } from 'zod';

export const writeSchema = z.object({
  subject: z.string().max(200).optional().nullable(),
  preheader: z.string().max(200).optional().nullable(),
  bodyJson: z.string().max(100_000).optional().nullable(),
  ctaLabel: z.string().trim().max(40).optional().nullable(),
  ctaHref: z.string().trim().max(500).optional().nullable(),
  imageKey: z.string().trim().max(500).optional().nullable(),
  audienceFilters: newsletterAudienceFiltersSchema.optional(),
});

export const audienceCountSchema = z.object({
  audienceFilters: newsletterAudienceFiltersSchema.optional(),
});

export const previewSchema = writeSchema.extend({
  firstName: z.string().trim().max(80).optional(),
  name: z.string().trim().max(120).optional(),
  username: z.string().trim().max(40).optional(),
});

export const scheduleSchema = z.object({
  scheduledAt: z.string().datetime({ offset: true }).or(z.string().datetime()),
});

export const listSchema = z.object({ limit: z.coerce.number().int().min(1).max(50).optional() });
