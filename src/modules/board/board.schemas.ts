import { BOARD_MAX_TAGS, BOARD_TITLE_MAX } from './board.utils';
import { limitQuery } from '../../common/pagination/cursor-query.schema';
import { z } from 'zod';

export const visibilitySchema = z.enum(['public', 'verifiedOnly', 'premiumOnly']);

export const tagsQuerySchema = z
  .union([z.string(), z.array(z.string())])
  .optional()
  .transform((v) => (Array.isArray(v) ? v : (v ?? '').split(',')).map((t) => t.trim()).filter(Boolean).slice(0, BOARD_MAX_TAGS));

export const listSchema = z.object({
  sort: z.enum(['top', 'new']).optional(),
  range: z.enum(['day', 'week', 'month', 'year', 'all']).optional(),
  visibility: z.enum(['all', 'public', 'verifiedOnly', 'premiumOnly']).optional(),
  tags: tagsQuerySchema,
  domain: z.string().trim().max(200).optional(),
  q: z.string().trim().max(120).optional(),
  author: z.string().trim().max(120).optional(),
  hidden: z.enum(['only']).optional(),
  limit: limitQuery(50),
  cursor: z.string().max(200).optional(),
});

export const commentsListSchema = z.object({
  author: z.string().trim().max(120).optional(),
  limit: limitQuery(50),
  cursor: z.string().max(200).optional(),
});

export const createThreadSchema = z.object({
  title: z.string().trim().min(1).max(BOARD_TITLE_MAX),
  url: z.string().trim().max(2048).nullable().optional(),
  body: z.string().max(2000).nullable().optional(),
  image: z
    .object({
      r2Key: z.string().trim().min(1).max(512),
      width: z.number().int().positive().nullable().optional(),
      height: z.number().int().positive().nullable().optional(),
      alt: z.string().max(500).nullable().optional(),
    })
    .nullable()
    .optional(),
  tags: z.array(z.string().trim().max(40)).max(BOARD_MAX_TAGS).optional(),
  visibility: visibilitySchema.optional(),
  showInFeed: z.boolean().optional(),
  /** Only honored for public threads that are also posted to the feed. Always shares a link to the thread. */
  crosspost: z.object({ pickax: z.literal('link').optional(), x: z.literal('link').optional() }).strict().optional(),
});

export const updateThreadSchema = z.object({
  title: z.string().trim().min(1).max(BOARD_TITLE_MAX).optional(),
  url: z.string().trim().max(2048).nullable().optional(),
  body: z.string().max(2000).optional(),
  tags: z.array(z.string().trim().max(40)).max(BOARD_MAX_TAGS).optional(),
});

export const createCommentSchema = z.object({
  body: z.string().trim().min(1).max(2000),
  parentId: z.string().trim().min(1).nullable().optional(),
});

export const preferencesSchema = z.object({
  shareToFeedDefault: z.boolean().optional(),
  articlePostToBoardDefault: z.boolean().optional(),
});
