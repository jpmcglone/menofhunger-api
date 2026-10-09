import { cursorPageQuerySchema, limitQuery } from '../../common/pagination/cursor-query.schema';
import { z } from 'zod';

export const listConversationsSchema = z.object({
  tab: z.enum(['primary', 'requests']).optional(),
  limit: limitQuery(50),
  cursor: z.string().optional(),
});

export const searchConversationsSchema = z.object({
  q: z.string().trim().min(1).max(200),
  limit: limitQuery(50),
});

export const listMessagesSchema = cursorPageQuerySchema();

export const messageMediaSchema = z.discriminatedUnion('source', [
  z.object({
    source: z.literal('upload'),
    kind: z.enum(['image', 'gif', 'video', 'audio']),
    r2Key: z.string().min(1),
    thumbnailR2Key: z.string().optional().nullable(),
    width: z.coerce.number().int().positive().optional().nullable(),
    height: z.coerce.number().int().positive().optional().nullable(),
    durationSeconds: z.coerce.number().min(0).optional().nullable(),
    alt: z.string().max(500).optional().nullable(),
  }),
  z.object({
    source: z.literal('giphy'),
    kind: z.literal('gif'),
    url: z.string().url(),
    mp4Url: z.string().url().optional().nullable(),
    width: z.coerce.number().int().positive().optional().nullable(),
    height: z.coerce.number().int().positive().optional().nullable(),
    alt: z.string().max(500).optional().nullable(),
  }),
]);

export const createConversationSchema = z
  .object({
    user_ids: z.array(z.string().trim().min(1)).min(1).max(50),
    title: z.string().trim().max(120).optional(),
    body: z.string().trim().max(2000).optional(),
    media: z.array(messageMediaSchema).max(1).optional(),
  })
  .refine((val) => (val.body?.trim()?.length ?? 0) > 0 || (val.media?.length ?? 0) > 0, {
    message: 'Message must have a body or media.',
  });

export const sendMessageSchema = z
  .object({
    body: z.string().trim().max(2000).optional(),
    replyToId: z.string().trim().min(1).optional(),
    media: z.array(messageMediaSchema).max(1).optional(),
  })
  .refine((val) => (val.body?.trim()?.length ?? 0) > 0 || (val.media?.length ?? 0) > 0, {
    message: 'Message must have a body or media.',
  });

export const voicemailSchema = z.object({
  source: z.literal('upload'),
  kind: z.literal('video'),
  r2Key: z.string().min(1),
  thumbnailR2Key: z.string().optional().nullable(),
  width: z.coerce.number().int().positive().optional().nullable(),
  height: z.coerce.number().int().positive().optional().nullable(),
  durationSeconds: z.coerce.number().min(0).max(60).optional().nullable(),
  alt: z.string().max(500).optional().nullable(),
});

export const blockUserSchema = z.object({
  user_id: z.string().trim().min(1),
});

export const lookupConversationSchema = z.object({
  user_ids: z.array(z.string().trim().min(1)).min(1).max(50),
});

export const addReactionSchema = z.object({
  reactionId: z.string().trim().min(1),
});
