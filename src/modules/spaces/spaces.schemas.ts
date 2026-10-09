import { z } from 'zod';

export const createSpaceSchema = z.object({
  title: z.string().trim().min(1).max(100),
  description: z.string().trim().max(500).nullish(),
});

export const updateSpaceSchema = z.object({
  title: z.union([z.string().trim().max(100), z.null()]).optional()
    .transform((value) => (value === '' ? null : value)),
  description: z.string().trim().max(500).nullish(),
});

export const setModeSchema = z.object({
  mode: z.enum(['NONE', 'WATCH_PARTY', 'RADIO']),
  watchPartyUrl: z.string().trim().max(2000).nullish(),
  radioStreamUrl: z.string().trim().max(2000).nullish(),
});

export const setScheduleSchema = z.object({
  scheduledAt: z.string().datetime({ offset: true }).or(z.string().datetime()),
});
