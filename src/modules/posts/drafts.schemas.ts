import { cursorPageQuerySchema } from '../../common/pagination/cursor-query.schema';
import { z } from 'zod';

export const draftMediaUploadSchema = z.object({
  source: z.literal('upload'),
  kind: z.enum(['image', 'gif', 'video']),
  r2Key: z.string().min(1),
  thumbnailR2Key: z.string().min(1).optional(),
  width: z.coerce.number().int().min(1).max(20000).optional(),
  height: z.coerce.number().int().min(1).max(20000).optional(),
  durationSeconds: z.coerce.number().int().min(0).max(3600).optional(),
  alt: z.string().trim().max(500).nullish(),
});

export const draftMediaSchema = z.discriminatedUnion('source', [
  draftMediaUploadSchema,
  z.object({
    source: z.literal('giphy'),
    kind: z.literal('gif'),
    url: z.string().url(),
    mp4Url: z.string().url().optional(),
    width: z.coerce.number().int().min(1).max(20000).optional(),
    height: z.coerce.number().int().min(1).max(20000).optional(),
    alt: z.string().trim().max(500).nullish(),
  }),
]);

export const listSchema = cursorPageQuerySchema();

export const createSchema = z.object({
  body: z.string().trim().max(1000).optional(),
  media: z.array(draftMediaSchema).max(4).optional(),
});

export const patchSchema = z.object({
  body: z.string().trim().max(1000).optional(),
  media: z.array(draftMediaSchema).max(4).optional(),
});
