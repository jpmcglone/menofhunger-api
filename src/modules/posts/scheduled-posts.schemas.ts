import { cursorPageQuerySchema } from '../../common/pagination/cursor-query.schema';
import { z } from 'zod';

export const mediaUploadSchema = z.object({
  source: z.literal('upload'),
  kind: z.enum(['image', 'gif', 'video']),
  r2Key: z.string().min(1),
  thumbnailR2Key: z.string().min(1).optional(),
  width: z.coerce.number().int().min(1).max(20000).optional(),
  height: z.coerce.number().int().min(1).max(20000).optional(),
  durationSeconds: z.coerce.number().int().min(0).max(3600).optional(),
  alt: z.string().trim().max(500).nullish(),
});

export const mediaGiphySchema = z.object({
  source: z.literal('giphy'),
  kind: z.literal('gif'),
  url: z.string().url(),
  mp4Url: z.string().url().optional(),
  width: z.coerce.number().int().min(1).max(20000).optional(),
  height: z.coerce.number().int().min(1).max(20000).optional(),
  alt: z.string().trim().max(500).nullish(),
});

export const mediaExistingSchema = z.object({
  source: z.literal('existing'),
  id: z.string().min(1),
  alt: z.string().trim().max(500).nullish(),
});

// Create only accepts upload + giphy (new media).
export const mediaCreateSchema = z.discriminatedUnion('source', [mediaUploadSchema, mediaGiphySchema]);

// Update also accepts 'existing' references (unchanged media from the holding row).
export const mediaUpdateSchema = z.discriminatedUnion('source', [mediaExistingSchema, mediaUploadSchema, mediaGiphySchema]);

export const pollOptionSchema = z.object({ text: z.string().trim().min(1).max(80) });

export const pollSchema = z.object({
  options: z.array(pollOptionSchema).min(2).max(4),
  durationHours: z.number().int().min(1).max(168),
});

export const crosspostSchema = z.object({ pickax: z.enum(['link', 'native']).optional(), x: z.literal('native').optional() }).strict();

export const createSchema = z.object({
  crosspost: crosspostSchema.optional(),
  body: z.string().trim().max(1000).default(''),
  visibility: z.enum(['public', 'verifiedOnly', 'premiumOnly']),
  scheduled_at: z
    .string()
    .datetime()
    .transform((v) => new Date(v)),
  media: z.array(mediaCreateSchema).max(4).optional(),
  poll: pollSchema.nullish(),
  community_group_id: z.string().trim().nullish(),
});

export const updateSchema = z.object({
  crosspost: crosspostSchema.optional(),
  body: z.string().trim().max(1000).optional(),
  visibility: z.enum(['public', 'verifiedOnly', 'premiumOnly']).optional(),
  scheduled_at: z
    .string()
    .datetime()
    .transform((v) => new Date(v))
    .optional(),
  media: z.array(mediaUpdateSchema).max(4).nullish(),
  poll: pollSchema.nullish(),
  community_group_id: z.string().trim().nullish(),
});

export const listSchema = cursorPageQuerySchema();
