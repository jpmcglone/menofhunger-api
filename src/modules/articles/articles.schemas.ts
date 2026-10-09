import { cursorPageQuerySchema } from '../../common/pagination/cursor-query.schema';
import { queryBoolean } from '../../common/validation/query-boolean';
import { z } from 'zod';

export const visibilitySchema = z.enum(["public", "verifiedOnly", "premiumOnly"]);

export const createSchema = z.object({
  title: z.string().trim().max(200).optional(),
  visibility: visibilitySchema.optional(),
});

export const tagSchema = z
  .array(z.string().trim().min(1).max(50))
  .max(10)
  .optional()
  .transform((tags) => tags?.map((t) => t.trim()).filter(Boolean));

export const saveSchema = z.object({
  title: z.string().trim().max(200).optional(),
  body: z.string().max(500_000).optional(),
  thumbnailR2Key: z.string().nullable().optional(),
  visibility: visibilitySchema.optional(),
  tags: tagSchema,
});

export const listSchema = cursorPageQuerySchema().extend({
  
  authorUsername: z.string().optional(),
  sort: z.enum(["new", "trending"]).optional(),
  visibility: z
    .enum(["all", "public", "verifiedOnly", "premiumOnly"])
    .optional(),
  mine: queryBoolean().optional(),
  followingOnly: queryBoolean().optional(),
  includeRestricted: queryBoolean().optional(),
  tag: z.string().trim().max(60).optional(),
  includeBody: queryBoolean().optional(),
});

export const publishSchema = z.object({
  postToBoard: z.boolean().optional(),
  shareToFeed: z.boolean().optional(),
  /** Also publish to the author's connected Pickax account when the article is public. */
  crossPostToPickax: z.boolean().optional(),
  /** Explicit link or native choice; the worker revalidates account capabilities. */
  crosspost: z
    .object({
      pickax: z.enum(["link", "native"]).optional(),
      x: z.enum(["link", "native"]).optional(),
    })
    .optional(),
});

export const draftsListSchema = cursorPageQuerySchema().extend({
  
  visibility: z
    .enum(["all", "public", "verifiedOnly", "premiumOnly"])
    .optional(),
});

export const commentListSchema = cursorPageQuerySchema();

export const commentCreateSchema = z.object({
  body: z.string().trim().min(1).max(1000),
  parentId: z.string().optional(),
});

export const commentUpdateSchema = z.object({
  body: z.string().trim().min(1).max(1000),
});

export const reactionSchema = z.object({
  reactionId: z.string().trim().min(1),
});

export const shareSchema = z.object({
  body: z.string().trim().max(1000).optional(),
  visibility: visibilitySchema.optional(),
});
