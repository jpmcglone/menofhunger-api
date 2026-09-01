import { z } from 'zod';
import type { Prisma } from '@prisma/client';
import { easternDayKey } from '../../common/time/eastern-day-key';
import {
  NEWSLETTER_DURATION_UNITS,
  type NewsletterAudienceFilter,
  type NewsletterDurationUnit,
} from '../../common/dto/newsletter.dto';

export const NEWSLETTER_AUDIENCE_FILTER_TYPES = ['inactive', 'joined', 'tier', 'noCheckin'] as const;

const amountSchema = z.number().int().min(1).max(3650);
const unitSchema = z.enum(NEWSLETTER_DURATION_UNITS);

export const newsletterAudienceFilterSchema: z.ZodType<NewsletterAudienceFilter> = z.discriminatedUnion('type', [
  z.object({ type: z.literal('inactive'), amount: amountSchema, unit: unitSchema }),
  z.object({
    type: z.literal('joined'),
    cmp: z.enum(['atLeast', 'inTheLast']),
    amount: amountSchema,
    unit: unitSchema,
  }),
  z.object({ type: z.literal('tier'), min: z.enum(['verified', 'premium']) }),
  z.object({ type: z.literal('noCheckin'), amount: amountSchema, unit: unitSchema }),
]);

export const newsletterAudienceFiltersSchema = z
  .array(newsletterAudienceFilterSchema)
  .max(NEWSLETTER_AUDIENCE_FILTER_TYPES.length)
  .superRefine((filters, ctx) => {
    const types = filters.map((f) => f.type);
    if (new Set(types).size !== types.length) {
      ctx.addIssue({ code: 'custom', message: 'Each audience filter can only be used once.' });
    }
  });

export function parseAudienceFilters(raw: unknown): NewsletterAudienceFilter[] {
  const parsed = newsletterAudienceFiltersSchema.safeParse(Array.isArray(raw) ? raw : []);
  return parsed.success ? parsed.data : [];
}

export function dateMinus(now: Date, amount: number, unit: NewsletterDurationUnit): Date {
  const next = new Date(now.getTime());
  if (unit === 'days') next.setUTCDate(next.getUTCDate() - amount);
  else if (unit === 'weeks') next.setUTCDate(next.getUTCDate() - amount * 7);
  else if (unit === 'months') next.setUTCMonth(next.getUTCMonth() - amount);
  else next.setUTCFullYear(next.getUTCFullYear() - amount);
  return next;
}

export function audienceFilterWhere(
  filter: NewsletterAudienceFilter,
  now: Date,
): Prisma.UserWhereInput {
  if (filter.type === 'inactive') {
    const cutoff = dateMinus(now, filter.amount, filter.unit);
    return { OR: [{ lastSeenAt: null }, { lastSeenAt: { lt: cutoff } }] };
  }
  if (filter.type === 'joined') {
    const cutoff = dateMinus(now, filter.amount, filter.unit);
    return filter.cmp === 'atLeast' ? { createdAt: { lte: cutoff } } : { createdAt: { gte: cutoff } };
  }
  if (filter.type === 'tier') {
    if (filter.min === 'premium') {
      return { OR: [{ premium: true }, { premiumPlus: true }] };
    }
    return {
      OR: [{ verifiedStatus: { not: 'none' } }, { premium: true }, { premiumPlus: true }],
    };
  }
  const cutoffKey = easternDayKey(dateMinus(now, filter.amount, filter.unit));
  return { OR: [{ lastCheckinDayKey: null }, { lastCheckinDayKey: { lt: cutoffKey } }] };
}

export function audienceFiltersWhere(
  filters: NewsletterAudienceFilter[],
  now: Date = new Date(),
): Prisma.UserWhereInput[] {
  return filters.map((filter) => audienceFilterWhere(filter, now));
}
